'use strict';

// 微信公众号网页授权（OAuth2）独立模块。
//
// 设计原则：
// - 未配置、配置不完整、已停用或不在微信浏览器内时，enabled=false；
// - 不校验配置、不打印配置状态、不发起任何微信网络请求；
// - 主流程只需要调用 createAuthorizeUrl(req)，返回空字符串就继续本机登录。
//
// 说明：当前系统只使用 code 换取 openid/用户资料，没有使用微信长效
// access_token，也没有 token 刷新流程；这里只迁移现有能力，不新增功能。

const crypto = require('crypto');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;
const AUTHORIZE_ENDPOINT =
  'https://open.weixin.qq.com/connect/oauth2/authorize';

function cleanText(raw, maxLength) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeAvatar(raw) {
  let avatar = String(raw == null ? '' : raw).trim();

  if (avatar.indexOf('http://') === 0) {
    avatar = 'https://' + avatar.slice('http://'.length);
  }

  if (
    avatar.length <= 500 &&
    /^https:\/\/(?:[a-z0-9-]+\.)*(?:qlogo\.cn|weixin\.qq\.com|wx\.qq\.com)\/[^\s"'<>]+$/i.test(
      avatar
    )
  ) {
    return avatar;
  }

  return '';
}

function createFetchJson(timeoutMs) {
  return async function fetchJson(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }

    if (!response.ok) {
      const error = new Error(
        (data && (data.errmsg || data.message)) || '微信接口请求失败'
      );
      error.data = data;
      throw error;
    }

    return data;
  };
}

class WechatAuth {
  constructor(options) {
    const opts = options || {};

    this.publicBaseUrl = String(opts.publicBaseUrl || '').trim();
    this.fetchJson =
      typeof opts.fetchJson === 'function'
        ? opts.fetchJson
        : createFetchJson(8000);
    this.states = new Map();
    this.loginCodes = new Map();

    this.reload(opts.config);
  }

  // 读取公众号配置。缺少字段只意味着功能未激活，不是错误。
  reload(rawConfig) {
    const source =
      rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

    this.appId = String(source.appId || '').trim();
    this.appSecret = String(source.appSecret || '').trim();
    this.enabled = !!(
      source.enabled === true &&
      this.appId &&
      this.appSecret
    );
  }

  isWechatBrowser(req) {
    const userAgent = String(
      (req && typeof req.get === 'function' && req.get('user-agent')) || ''
    );
    return /MicroMessenger/i.test(userAgent);
  }

  canStart(req) {
    return this.enabled && this.isWechatBrowser(req);
  }

  resolveBaseUrl(req) {
    if (this.publicBaseUrl) {
      try {
        const parsed = new URL(this.publicBaseUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.origin;
        }
      } catch (err) {
        // 未配置或格式不合法时退回请求地址；不做启动校验
      }
    }

    return req.protocol + '://' + req.get('host');
  }

  createAuthorizeUrl(req) {
    if (!this.enabled) return '';

    const state = crypto.randomBytes(16).toString('hex');
    this.states.set(state, Date.now() + OAUTH_STATE_TTL_MS);

    const callback =
      this.resolveBaseUrl(req) + '/api/auth/wechat/callback';
    const query = new URLSearchParams({
      appid: this.appId,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'snsapi_userinfo',
      state,
    });

    return AUTHORIZE_ENDPOINT + '?' + query.toString() + '#wechat_redirect';
  }

  consumeState(state) {
    const key = String(state || '');
    const expiresAt = this.states.get(key);
    this.states.delete(key);
    return !!expiresAt && expiresAt >= Date.now();
  }

  async exchangeCode(code) {
    if (!this.enabled) {
      throw new Error('微信授权未启用');
    }

    const tokenUrl =
      'https://api.weixin.qq.com/sns/oauth2/access_token?' +
      new URLSearchParams({
        appid: this.appId,
        secret: this.appSecret,
        code: String(code || ''),
        grant_type: 'authorization_code',
      }).toString();

    const tokenData = await this.fetchJson(tokenUrl);

    if (tokenData.errcode) {
      throw new Error(tokenData.errmsg || '微信授权失败');
    }

    const openid = String(tokenData.openid || '');
    if (!openid) throw new Error('微信没有返回 openid');

    let nickname = '';
    let avatar = '';

    // 用户资料只用于首次设置页的预填，失败不影响登录
    if (tokenData.access_token) {
      try {
        const userUrl =
          'https://api.weixin.qq.com/sns/userinfo?' +
          new URLSearchParams({
            access_token: String(tokenData.access_token),
            openid,
            lang: 'zh_CN',
          }).toString();
        const wxUser = await this.fetchJson(userUrl);

        if (!wxUser.errcode) {
          nickname = cleanText(wxUser.nickname, 16);
          avatar = normalizeAvatar(wxUser.headimgurl);
        }
      } catch (err) {
        // 静默忽略：昵称头像预填不是登录必要条件
      }
    }

    return { openid, nickname, avatar };
  }

  // 微信回调后，不把本系统 token 放进 URL，改用一次性登录码中转
  createLoginCode(userId) {
    const code = crypto.randomBytes(24).toString('hex');
    this.loginCodes.set(code, {
      userId: String(userId || ''),
      expiresAt: Date.now() + LOGIN_CODE_TTL_MS,
    });
    return code;
  }

  consumeLoginCode(code) {
    const key = String(code || '');
    const record = this.loginCodes.get(key);
    this.loginCodes.delete(key);

    if (!record || record.expiresAt < Date.now()) return '';
    return record.userId;
  }

  cleanup(now) {
    const current = Number(now) || Date.now();

    this.states.forEach((expiresAt, key) => {
      if (expiresAt < current) this.states.delete(key);
    });

    this.loginCodes.forEach((record, key) => {
      if (record.expiresAt < current) this.loginCodes.delete(key);
    });
  }
}

function createWechatAuth(options) {
  return new WechatAuth(options);
}

module.exports = { createWechatAuth };
