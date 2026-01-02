/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { refreshLiveChannels } from '@/lib/live';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    // 权限检查
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    if (authInfo.role !== 'owner' && authInfo.role !== 'admin') {
      return NextResponse.json(
        { error: '权限不足，无法执行此操作' },
        { status: 401 }
      );
    }

    const config = await getConfig();
    if (!config) {
      return NextResponse.json({ error: '配置不存在' }, { status: 404 });
    }

    // 并发刷新所有启用的直播源
    const refreshPromises = (config.LiveConfig || [])
      .filter(liveInfo => !liveInfo.disabled)
      .map(async (liveInfo) => {
        try {
          const nums = await refreshLiveChannels(liveInfo);
          liveInfo.channelNumber = nums;
        } catch (error) {
          liveInfo.channelNumber = 0;
        }
      });

    // 等待所有刷新任务完成
    await Promise.all(refreshPromises);

    // 保存配置
    await db.saveAdminConfig(config);

    return NextResponse.json({
      success: true,
      message: '直播源刷新成功',
    });
  } catch (error) {
    console.error('直播源刷新失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '刷新失败' },
      { status: 500 }
    );
  }
}
