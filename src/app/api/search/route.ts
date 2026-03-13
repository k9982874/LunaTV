/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from "next/server";

import { getAuthInfoFromCookie } from "@/lib/auth";
import { getAvailableApiSites, getCacheTime, getConfig } from "@/lib/config";
import { searchFromApi } from "@/lib/downstream";
import redis, { getCacheKey } from "@/lib/redis";
import { yellowWords } from "@/lib/yellow";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
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

  // 添加超时控制和错误处理，避免慢接口拖累整体响应
  const searchPromises = apiSites.map((site) =>
    Promise.race([
      searchFromApi(site, query),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${site.name} timeout`)), 20000),
      ),
    ]).catch((err) => {
      console.warn(`搜索失败 ${site.name}:`, err.message);
      return []; // 返回空数组而不是抛出错误
    }),
  );

  try {
    const results = await Promise.allSettled(searchPromises);
    const successResults = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => (result as PromiseFulfilledResult<any>).value);
    let flattenedResults = successResults.flat();
    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || "";
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }
    const cacheTime = await getCacheTime();

    if (flattenedResults.length === 0) {
      // no cache if empty
      return NextResponse.json({ results: [] }, { status: 200 });
    }

    const tasks = [];
    for (const result of flattenedResults) {
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
      { results: flattenedResults },
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
    return NextResponse.json({ error: "搜索失败" }, { status: 500 });
  }
}
