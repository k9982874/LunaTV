import { NextRequest, NextResponse } from "next/server";

import { getAuthInfoFromCookie } from "@/lib/auth";
import { getAvailableApiSites, getCacheTime, getConfig } from "@/lib/config";
import { searchFromApi } from "@/lib/downstream";
import redis, { getCacheKey } from "@/lib/redis";
import { yellowWords } from "@/lib/yellow";

export const runtime = "nodejs";

// OrionTV 兼容接口
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const resourceId = searchParams.get("resourceId");

  if (!query || !resourceId) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { result: null, error: "缺少必要参数: q 或 resourceId" },
      {
        headers: {
          "Cache-Control": `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          "CDN-Cache-Control": `public, s-maxage=${cacheTime}`,
          "Vercel-CDN-Cache-Control": `public, s-maxage=${cacheTime}`,
          "Netlify-Vary": "query",
        },
      },
    );
  }

  const config = await getConfig();
  const apiSites = await getAvailableApiSites(authInfo.username);

  try {
    // 根据 resourceId 查找对应的 API 站点
    const targetSite = apiSites.find((site) => site.key === resourceId);
    if (!targetSite) {
      return NextResponse.json(
        {
          error: `未找到指定的视频源: ${resourceId}`,
          result: null,
        },
        { status: 404 },
      );
    }

    const results = await searchFromApi(targetSite, query);
    let successResults = results.filter((r) => r.title === query);
    if (!config.SiteConfig.DisableYellowFilter) {
      successResults = successResults.filter((result) => {
        const typeName = result.type_name || "";
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }
    const cacheTime = await getCacheTime();

    if (successResults.length === 0) {
      return NextResponse.json(
        {
          error: "未找到结果",
          result: null,
        },
        { status: 404 },
      );
    }

    const tasks = [];
    for (const result of successResults) {
      const data = result.episodes.reduce(
        (
          acc: Map<string, string>,
          cur: string,
          index: number,
        ): Map<string, string> => {
          const name = result.episodes_titles[index];
          acc.set(name, cur);

          const url = `${process.env.SITE_BASE}/api/play/${result.source}/${result.id}/${name}.m3u8`;
          result.episodes[index] = url;

          return acc;
        },
        new Map<string, string>(),
      );

      const key = getCacheKey(result.source, result.id);
      tasks.push(
        redis.hset(key, data, (_, result) => {
          if (result === 1) {
            redis.expire(key, 8 * 60 * 60); // 8小时过期
          }
        }),
      );
    }

    await Promise.all(tasks);

    return NextResponse.json(
      { results: successResults },
      {
        headers: {
          "Cache-Control": `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          "CDN-Cache-Control": `public, s-maxage=${cacheTime}`,
          "Vercel-CDN-Cache-Control": `public, s-maxage=${cacheTime}`,
          "Netlify-Vary": "query",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "搜索失败",
        result: null,
      },
      { status: 500 },
    );
  }
}
