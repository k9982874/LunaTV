/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from "next/server";

import { defalutUserAgent } from "@/lib/config";
import redis, { getCacheKey } from "@/lib/redis";
import { randomString } from "@/lib/utils";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  let urlPathname = request.nextUrl.pathname;
  if (urlPathname.endsWith(".m3u8")) {
    urlPathname = urlPathname.substring(0, urlPathname.length - 5);
  }

  const [source, id, name, pathname] = urlPathname.split("/").slice(3);

  try {
    if (!source || !id || !name) {
      return NextResponse.json(
        {
          error: "Missing source, id or name",
        },
        { status: 400 },
      );
    }

    const key = getCacheKey(source, id);

    let decodedName = decodeURIComponent(name);
    if (pathname) {
      decodedName = decodedName + "-" + pathname;
    }

    const m3u8Url = await redis.hget(key, decodedName);
    if (!m3u8Url) {
      return NextResponse.json({ error: "Data not found" }, { status: 404 });
    }

    const response = await fetch(m3u8Url, {
      headers: {
        "User-Agent": defalutUserAgent,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "获取 m3u8 文件失败" },
        { status: response.status },
      );
    }

    let m3u8Content = await response.text();

    // 使用默认去广告规则
    m3u8Content = filterAdsFromM3U8Default(source, m3u8Content);

    // 处理 m3u8 中的相对链接
    m3u8Content = await resolveM3u8Links(
      source,
      id,
      decodedName,
      m3u8Url,
      m3u8Content,
    );

    return new NextResponse(m3u8Content, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("代理 m3u8 失败:", error);
    return NextResponse.json(
      { error: "Failed to fetch m3u8" },
      { status: 500 },
    );
  }
}

/**
 * 将 m3u8 中的相对链接转换为绝对链接，并将子 m3u8 链接转为代理链接
 */
async function resolveM3u8Links(
  source: string,
  id: string,
  name: string,
  baseUrl: string,
  m3u8Content: string,
): Promise<string> {
  const resolvedLines = [];

  let isNextLineUrl = false;

  const lines = m3u8Content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // 空行直接保留
    if (line === "") {
      resolvedLines.push(line);
      continue;
    }

    // 注释行直接保留
    if (line.startsWith("#")) {
      // 处理 EXT-X-KEY 标签中的 URI
      if (line.startsWith("#EXT-X-KEY:")) {
        // 提取 URI 部分
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch && uriMatch[1]) {
          let keyUri = uriMatch[1];

          // 转换为绝对路径
          if (!keyUri.startsWith("http://") && !keyUri.startsWith("https://")) {
            const url = new URL(keyUri, baseUrl);
            line = line.replace(/URI="[^"]+"/, `URI="${url.toString()}"`);
          }
        }
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        // 检查是否是 EXT-X-STREAM-INF，下一行将是子 m3u8
        isNextLineUrl = true;
      } else if (line.startsWith("#EXTINF:")) {
        // 检查是否是 EXTINF，下一行将是子 m3u8
        isNextLineUrl = true;
      }
      resolvedLines.push(line);
      continue;
    }

    // 处理 URL 行
    if (isNextLineUrl) {
      // 转换为绝对路径
      if (!line.startsWith("http://") && !line.startsWith("https://")) {
        line = new URL(line, baseUrl).toString();
      }

      let extname = "";

      const pos = line.indexOf("?");
      if (pos !== -1) {
        extname = line.substring(pos - 5, pos);
      } else {
        extname = line.substring(line.length - 5);
      }

      if (extname === ".m3u8") {
        const key = getCacheKey(source, id);

        const randomKey = randomString(10).trim();
        await redis.hset(key, name + "-" + randomKey, line);
        line = `${process.env.SITE_BASE}/api/play/${source}/${id}/${name}/${randomKey}.m3u8`;
      }

      resolvedLines.push(line);

      isNextLineUrl = false;
    }
  }

  return resolvedLines.join("\n");
}

/**
 * 默认去广告规则
 */
function filterAdsFromM3U8Default(type: string, m3u8Content: string): string {
  if (!m3u8Content) return "";

  // 按行分割M3U8内容
  const lines = m3u8Content.split("\n");
  const filteredLines = [];

  let nextdelete = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (nextdelete) {
      nextdelete = false;
      continue;
    }

    // 只过滤#EXT-X-DISCONTINUITY标识
    if (!line.includes("#EXT-X-DISCONTINUITY")) {
      if (
        type === "ruyi" &&
        (line.includes("EXTINF:5.640000") ||
          line.includes("EXTINF:2.960000") ||
          line.includes("EXTINF:3.480000") ||
          line.includes("EXTINF:4.000000") ||
          line.includes("EXTINF:0.960000") ||
          line.includes("EXTINF:10.000000") ||
          line.includes("EXTINF:1.266667"))
      ) {
        nextdelete = true;
        continue;
      }

      filteredLines.push(line);
    }
  }

  return filteredLines.join("\n");
}
