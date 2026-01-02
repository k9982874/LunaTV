/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { AdminConfig } from '../admin.types';
import { ApiSource, Category, Favorite, IStorage, LiveSource, PlayRecord, SkipConfig, User, UserGroup } from '../types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

function StringArray(value: any[]): string[] {
  return value.map((item) => String(item));
}

// 获取 SQLite 数据库路径
function getDatabasePath(): string {
  const dbPath = process.env.SQLITE_DB_PATH;
  if (dbPath) {
    return dbPath;
  }
  // 默认路径：项目根目录下的 data 文件夹
  return path.join(process.cwd(), 'data', 'lunatv.db');
}

// 创建数据库连接（单例）
function getSqliteDatabase(): Database.Database {
  const globalKey = Symbol.for('__MOONTV_SQLITE_DB__');
  let db: Database.Database | undefined = (global as any)[globalKey];

  if (!db) {
    const dbPath = getDatabasePath();
    console.log(`SQLite database path: ${dbPath}`);

    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const initialized = fs.existsSync(dbPath);

    db = new Database(dbPath);

    // 启用 WAL 模式以提高并发性能
    db.pragma('journal_mode = WAL');

    // 启用外键约束
    db.pragma('foreign_keys = ON');

    // 初始化表结构
    if (!initialized) {
      initializeTables(db);
    }

    console.log('SQLite database connected successfully');

    (global as any)[globalKey] = db;
  }

  return db;
}

// 初始化数据库表结构
function initializeTables(db: Database.Database): void {
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      banned INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      enabled_apis TEXT
    )
  `);

  // 播放记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      record_key TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(username, record_key),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    )
  `);

  // 收藏表
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      favorite_key TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(username, favorite_key),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    )
  `);

  // 搜索历史表
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      keyword TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    )
  `);

  // 跳过片头片尾配置表
  db.exec(`
    CREATE TABLE IF NOT EXISTS skip_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      config_key TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(username, config_key),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    )
  `);

  // 管理员配置表（键值对结构）
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_config (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 用户组表
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_groups (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // API 源表
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_sources (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api TEXT NOT NULL,
      detail TEXT,
      from_source TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 直播源表
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_sources (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      user_agent TEXT,
      epg TEXT,
      from_source TEXT NOT NULL,
      channel_number INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 分类表
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      query TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT,
      from_source TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (query, type)
    )
  `);

  // 创建索引以提高查询性能
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_play_records_username ON play_records(username);
    CREATE INDEX IF NOT EXISTS idx_favorites_username ON favorites(username);
    CREATE INDEX IF NOT EXISTS idx_search_history_username ON search_history(username);
    CREATE INDEX IF NOT EXISTS idx_skip_configs_username ON skip_configs(username);
    CREATE INDEX IF NOT EXISTS idx_search_history_username_created ON search_history(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_sources_disabled ON api_sources(disabled);
    CREATE INDEX IF NOT EXISTS idx_live_sources_disabled ON live_sources(disabled);
    CREATE INDEX IF NOT EXISTS idx_categories_disabled ON categories(disabled);
    CREATE INDEX IF NOT EXISTS idx_categories_from_source ON categories(from_source);
  `);

  const stmt = db.prepare(`
    INSERT INTO users (username, password, role, banned)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, 'owner', 0);
}

// 添加 SQLite 操作重试包装器
async function withRetry<T>(
  operation: () => T,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return operation();
    } catch (err: any) {
      const isLastAttempt = i === maxRetries - 1;
      const isLockError =
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        err.message?.includes('database is locked');

      if (isLockError && !isLastAttempt) {
        console.log(
          `SQLite operation failed, retrying... (${i + 1}/${maxRetries})`
        );
        console.error('Error:', err.message);

        // 等待一段时间后重试（指数退避）
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
        continue;
      }

      throw err;
    }
  }

  throw new Error('Max retries exceeded');
}

export class SqliteStorage implements IStorage {
  private db: Database.Database;

  constructor() {
    this.db = getSqliteDatabase();
  }

  // ---------- 播放记录 ----------
  async getPlayRecord(
    userName: string,
    key: string
  ): Promise<PlayRecord | null> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT data FROM play_records WHERE username = ? AND record_key = ?'
      );
      const row = stmt.get(userName, key) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as PlayRecord) : null;
    });
  }

  async setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO play_records (username, record_key, data)
        VALUES (?, ?, ?)
      `);
      stmt.run(userName, key, JSON.stringify(record));
    });
  }

  async getAllPlayRecords(
    userName: string
  ): Promise<Record<string, PlayRecord>> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT record_key, data FROM play_records WHERE username = ?'
      );
      const rows = stmt.all(userName) as Array<{ record_key: string; data: string }>;
      const result: Record<string, PlayRecord> = {};
      rows.forEach((row) => {
        result[String(row.record_key)] = JSON.parse(row.data) as PlayRecord;
      });
      return result;
    });
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(
        'DELETE FROM play_records WHERE username = ? AND record_key = ?'
      );
      stmt.run(userName, key);
    });
  }

  // ---------- 收藏 ----------
  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT data FROM favorites WHERE username = ? AND favorite_key = ?'
      );
      const row = stmt.get(userName, key) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Favorite) : null;
    });
  }

  async setFavorite(
    userName: string,
    key: string,
    favorite: Favorite
  ): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO favorites (username, favorite_key, data)
        VALUES (?, ?, ?)
      `);
      stmt.run(userName, key, JSON.stringify(favorite));
    });
  }

  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT favorite_key, data FROM favorites WHERE username = ?'
      );
      const rows = stmt.all(userName) as Array<{ favorite_key: string; data: string }>;
      const result: Record<string, Favorite> = {};
      rows.forEach((row) => {
        result[String(row.favorite_key)] = JSON.parse(row.data) as Favorite;
      });
      return result;
    });
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(
        'DELETE FROM favorites WHERE username = ? AND favorite_key = ?'
      );
      stmt.run(userName, key);
    });
  }

  // ---------- 用户注册 / 登录 ----------
  async registerUser(userName: string, password: string): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(
        'INSERT INTO users (username, password, role, banned) VALUES (?, ?, ?, ?)'
      );
      stmt.run(userName, password, 'user', 0);
    });
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT password FROM users WHERE username = ?'
      );
      const row = stmt.get(userName) as { password: string } | undefined;
      if (!row) return false;
      return String(row.password) === password;
    });
  }

  // 检查用户是否存在
  async checkUserExist(userName: string): Promise<boolean> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT 1 FROM users WHERE username = ? LIMIT 1'
      );
      const row = stmt.get(userName);
      return row !== undefined;
    });
  }

  // 修改用户密码
  async changePassword(userName: string, newPassword: string): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(
        'UPDATE users SET password = ? WHERE username = ?'
      );
      stmt.run(newPassword, userName);
    });
  }

  // 删除用户及其所有数据（通过外键级联删除）
  async deleteUser(userName: string): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare('DELETE FROM users WHERE username = ?');
      stmt.run(userName);
      // 由于设置了外键级联删除，相关数据会自动删除
    });
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    return withRetry(() => {
      const stmt = this.db.prepare(`
        SELECT keyword FROM search_history
        WHERE username = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(userName, SEARCH_HISTORY_LIMIT) as Array<{ keyword: string }>;
      return StringArray(rows.map((row) => row.keyword));
    });
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    await withRetry(() => {
      // 先删除相同的关键词
      const deleteStmt = this.db.prepare(
        'DELETE FROM search_history WHERE username = ? AND keyword = ?'
      );
      deleteStmt.run(userName, String(keyword));

      // 插入新记录
      const insertStmt = this.db.prepare(`
        INSERT INTO search_history (username, keyword, created_at)
        VALUES (?, ?, strftime('%s', 'now'))
      `);
      insertStmt.run(userName, String(keyword));

      // 限制历史记录数量
      const limitStmt = this.db.prepare(`
        DELETE FROM search_history
        WHERE username = ? AND id NOT IN (
          SELECT id FROM search_history
          WHERE username = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
      `);
      limitStmt.run(userName, userName, SEARCH_HISTORY_LIMIT);
    });
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    await withRetry(() => {
      if (keyword) {
        const stmt = this.db.prepare(
          'DELETE FROM search_history WHERE username = ? AND keyword = ?'
        );
        stmt.run(userName, String(keyword));
      } else {
        const stmt = this.db.prepare(
          'DELETE FROM search_history WHERE username = ?'
        );
        stmt.run(userName);
      }
    });
  }

  // ---------- 获取全部用户 ----------
  async getAllUsers(withPassword?: boolean): Promise<(User & { password?: string })[]> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT username, password, role, banned, tags, enabled_apis FROM users',
      );
      const rows = stmt.all() as {
        username: string;
        password: string;
        role: string;
        banned: number;
        tags: string;
        enabled_apis: string;
      }[];
      return rows.map((row) => {
        const result: User & { password?: string } = {
          username: String(row.username),
          password: withPassword ? String(row.password) : undefined,
          role: (row.role || 'user') as 'user' | 'admin' | 'owner',
          banned: Boolean(row.banned),
          tags: [],
          enabledApis: [],
        };
        try {
          if (row.tags) {
            result.tags = JSON.parse(row.tags) as string[];
          }
          if (row.enabled_apis) {
            result.enabledApis = JSON.parse(row.enabled_apis) as string[];
          }
        } catch (e) {
          console.warn('解析用户组失败:', e);
        }
        return result;
      });
    });
  }

  // ---------- 设置全部用户 ----------
  async setAllUsers(users: Partial<User>[]): Promise<void> {
    await withRetry(() => {
      const updateUserStmt = this.db.prepare(`
        UPDATE users 
        SET role = ?, banned = ?, tags = ?, enabled_apis = ? 
        WHERE username = ?
      `);

      for (const user of users) {
        updateUserStmt.run(
          user.role || 'user',
          user.banned ? 1 : 0,
          JSON.stringify(user.tags || []),
          JSON.stringify(user.enabledApis || []),
          user.username
        );
      }
    });
  }

  // ---------- 获取全部用户组 ----------
  async getAllUserGroups(): Promise<UserGroup[]> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT name, value FROM user_groups',
      );
      const rows = stmt.all() as Array<{
        name: string;
        value: string;
      }>;
      return rows.map((row) => {
        const result: UserGroup = {
          name: String(row.name),
          enabledApis: [],
        };
        try {
          result.enabledApis = JSON.parse(row.value) as string[];
        } catch (e) {
          console.warn('解析用户组失败:', e);
        }
        return result;
      });
    });
  }

  // ---------- 设置全部用户组 ----------
  async setAllUserGroups(userGroups: Partial<{
    name: string;
    enabledApis: string[];
  }>[]): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO user_groups (name, value)
        VALUES (?, ?)
      `);
      for (const userGroup of userGroups) {
        const value = JSON.stringify(userGroup.enabledApis || []);
        stmt.run(userGroup.name, value);
      }
    });
  }

  // ---------- 获取全部 API 源 ----------
  async getAllApiSources(): Promise<ApiSource[]> {
    return withRetry(() => {
      const stmt = this.db.prepare('SELECT key, name, api, detail, from_source, disabled FROM api_sources');
      const rows = stmt.all() as Array<{ key: string; name: string; api: string; detail: string; from_source: string; disabled: number }>;
      return rows.map((row) => {
        return {
          key: String(row.key),
          name: String(row.name),
          api: String(row.api),
          detail: row.detail ? String(row.detail) : undefined,
          from: String(row.from_source) as 'config' | 'custom',
          disabled: Boolean(row.disabled),
        };
      });
    });
  }

  // ---------- 设置全部 API 源 ----------
  async setAllApiSources(apiSources: Partial<{
    key: string;
    name: string;
    api: string;
    detail: string;
    from: 'config' | 'custom';
    disabled: boolean;
  }>[]): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO api_sources (key, name, api, detail, from_source, disabled)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const apiSource of apiSources) {
        stmt.run(
          apiSource.key,
          apiSource.name,
          apiSource.api,
          apiSource.detail,
          apiSource.from,
          apiSource.disabled ? 1 : 0,
        );
      }
    });
  }

  // ---------- 获取全部直播源 ----------
  async getAllLiveSources(): Promise<LiveSource[]> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT key, name, url, user_agent, epg, from_source, channel_number, disabled FROM live_sources',
      );
      const rows = stmt.all() as Array<{
        key: string;
        name: string;
        url: string;
        user_agent: string;
        epg: string;
        from_source: string;
        channel_number: number;
        disabled: number
      }>;
      return rows.map((row) => {
        return {
          key: String(row.key),
          name: String(row.name),
          url: String(row.url),
          ua: row.user_agent ? String(row.user_agent) : undefined,
          epg: row.epg ? String(row.epg) : undefined,
          from: String(row.from_source) as 'config' | 'custom',
          channelNumber: row.channel_number ? Number(row.channel_number) : undefined,
          disabled: Boolean(row.disabled),
        };
      });
    });
  }

  // ---------- 设置全部直播源 ----------
  async setAllLiveSources(liveSources: Partial<{
    key: string;
    name: string;
    url: string;
    ua: string;
    epg: string;
    from: 'config' | 'custom';
    channelNumber: number;
    disabled: boolean;
  }>[]): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO live_sources (key, name, url, user_agent, epg, from_source, channel_number, disabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const liveSource of liveSources) {
        stmt.run(
          liveSource.key,
          liveSource.name,
          liveSource.url,
          liveSource.ua,
          liveSource.epg,
          liveSource.from,
          liveSource.channelNumber,
          liveSource.disabled ? 1 : 0,
        );
      }
    });
  }

  // ---------- 获取全部分类 ----------
  async getAllCategories(): Promise<Category[]> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT query, type, name, from_source, disabled FROM categories',
      );
      const rows = stmt.all() as Array<{
        query: string;
        type: string;
        name: string;
        from_source: string;
        disabled: number;
      }>;
      return rows.map((row) => {
        return {
          query: String(row.query),
          type: String(row.type) as 'movie' | 'tv',
          name: row.name ? String(row.name) : undefined,
          from: String(row.from_source) as 'config' | 'custom',
          disabled: Boolean(row.disabled),
        };
      });
    });
  }

  // ---------- 设置全部分类 ----------
  async setAllCategories(categories: Partial<{
    query: string;
    type: 'movie' | 'tv';
    name: string;
    from: 'config' | 'custom';
    disabled: boolean;
  }>[]): Promise<void> {
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO categories (query, type, name, from_source, disabled)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const category of categories) {
        stmt.run(
          category.query,
          category.type,
          category.name,
          category.from,
          category.disabled ? 1 : 0,
        );
      }
    });
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    return withRetry(async () => {
      const stmt = this.db.prepare('SELECT name, value FROM admin_config');
      const rows = stmt.all() as Array<{ name: string; value: string }>;
      if (!rows) {
        return null;
      }

      const config = {
        ConfigSubscribtion: {
          URL: '',
          AutoUpdate: false,
          LastCheck: '',
        },
        ConfigFile: '',
        UserConfig: {
          Users: [],
        },
        SiteConfig: {
          SiteName: process.env.NEXT_PUBLIC_SITE_NAME || 'LunaTV',
          Announcement:
            process.env.ANNOUNCEMENT ||
            '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
          SearchDownstreamMaxPage:
            Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
          SiteInterfaceCacheTime: 7200,
          DoubanProxyType:
            process.env.NEXT_PUBLIC_DOUBAN_PROXY_TYPE || 'cmliussss-cdn-tencent',
          DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
          DoubanImageProxyType:
            process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE || 'cmliussss-cdn-tencent',
          DoubanImageProxy: process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY || '',
          DisableYellowFilter:
            process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
          FluidSearch:
            process.env.NEXT_PUBLIC_FLUID_SEARCH !== 'false',
        },
        SourceConfig: [],
        CustomCategories: [],
        LiveConfig: [],
      } as AdminConfig;

      try {
        rows.forEach((row) => {
          if (row.name === 'config_file') {
            config.ConfigFile = row.value;
          } else if (row.name === 'config_subscription') {
            config.ConfigSubscribtion = JSON.parse(row.value);
          } else if (row.name === 'site_config') {
            config.SiteConfig = JSON.parse(row.value);
          } else if (row.name === 'source_config') {
            config.SourceConfig = JSON.parse(row.value);
          } else if (row.name === 'custom_categories') {
            config.CustomCategories = JSON.parse(row.value);
          } else if (row.name === 'live_config') {
            config.LiveConfig = JSON.parse(row.value);
          }
        });
      } catch (e) {
        console.error('解析管理员配置失败:', e);
        return null;
      }

      const allUsers = await this.getAllUsers();
      const allUserGroups = await this.getAllUserGroups();
      config.UserConfig = {
        Users: allUsers,
        Tags: allUserGroups,
      };

      const allApiSources = await this.getAllApiSources();
      config.SourceConfig = allApiSources;

      const allLiveSources = await this.getAllLiveSources();
      config.LiveConfig = allLiveSources;

      const allCategories = await this.getAllCategories();
      config.CustomCategories = allCategories;

      return config;
    });
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    await withRetry(async () => {
      if (config.ConfigFile) {
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO admin_config (name, value)
          VALUES (?, ?)
        `);
        stmt.run('config_file', config.ConfigFile);
      }

      if (config.ConfigSubscribtion) {
        const data = JSON.stringify(config.ConfigSubscribtion);
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO admin_config (name, value)
          VALUES (?, ?)
        `);
        stmt.run('config_subscription', data);
      }

      if (config.SiteConfig) {
        const data = JSON.stringify(config.SiteConfig);
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO admin_config (name, value)
          VALUES (?, ?)
        `);
        stmt.run('site_config', data);
      }

      // 同步更新 users 表中的 role 和 banned 字段
      if (config.UserConfig) {
        if (config.UserConfig.Users) {
          await this.setAllUsers(config.UserConfig.Users);
        }
        if (config.UserConfig.Tags) {
          await this.setAllUserGroups(config.UserConfig.Tags);
        }
      }

      if (config.SourceConfig) {
        await this.setAllApiSources(config.SourceConfig);
      }

      if (config.CustomCategories) {
        await this.setAllCategories(config.CustomCategories);
      }

      if (config.LiveConfig) {
        await this.setAllLiveSources(config.LiveConfig);
      }
    });
  }

  // ---------- 跳过片头片尾配置 ----------
  private skipConfigKey(source: string, id: string): string {
    return `${source}+${id}`;
  }

  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    const key = this.skipConfigKey(source, id);
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT data FROM skip_configs WHERE username = ? AND config_key = ?'
      );
      const row = stmt.get(userName, key) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as SkipConfig) : null;
    });
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    const key = this.skipConfigKey(source, id);
    await withRetry(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO skip_configs (username, config_key, data)
        VALUES (?, ?, ?)
      `);
      stmt.run(userName, key, JSON.stringify(config));
    });
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = this.skipConfigKey(source, id);
    await withRetry(() => {
      const stmt = this.db.prepare(
        'DELETE FROM skip_configs WHERE username = ? AND config_key = ?'
      );
      stmt.run(userName, key);
    });
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    return withRetry(() => {
      const stmt = this.db.prepare(
        'SELECT config_key, data FROM skip_configs WHERE username = ?'
      );
      const rows = stmt.all(userName) as Array<{ config_key: string; data: string }>;
      const configs: { [key: string]: SkipConfig } = {};
      rows.forEach((row) => {
        configs[String(row.config_key)] = JSON.parse(row.data) as SkipConfig;
      });
      return configs;
    });
  }

  // 清空所有数据
  async clearAllData(): Promise<void> {
    try {
      await withRetry(() => {
        // 删除所有表数据（由于外键约束，删除 users 会级联删除相关数据）
        this.db.exec(`
          DELETE FROM users;
          DELETE FROM admin_config;
        `);
      });

      console.log('所有数据已清空');
    } catch (error) {
      console.error('清空数据失败:', error);
      throw new Error('清空数据失败');
    }
  }
}

