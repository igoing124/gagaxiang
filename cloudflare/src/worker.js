'use strict';

// Cloudflare Workers 入口：
// - /api/* 交给唯一的 Durable Object（门店），所有订单、菜单、优惠券都在里面串行处理
// - 其余请求交给 Workers 静态资源（h5-order/public）

import { createShop, readConfig } from './app.js';
import { DocStore } from './store.js';

// 2026-10-23 正式营业存储：与部署验收使用的测试实例隔离，避免测试订单出现在真实后台。
const SHOP_NAME = 'gagaxiang-production-20261023';

export class Shop {
  constructor(ctx, env) {
    this.shop = createShop({
      store: new DocStore(ctx.storage.sql),
      config: readConfig(env),
    });
  }

  async fetch(request) {
    return this.shop.handle(request);
  }
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withStaticHeaders(response, pathname) {
  const next = withSecurityHeaders(response);
  const headers = next.headers;

  if (/\.(?:css|js|png|jpe?g|webp|svg|woff2?)$/i.test(pathname)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (/\.html?$/i.test(pathname) || pathname === '/') {
    headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  }

  return next;
}

function notFound() {
  return withSecurityHeaders(
    new Response('页面不存在', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  );
}

async function serveAsset(request, env, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';

  const response = await env.ASSETS.fetch(
    new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
    })
  );

  if (response.status === 404) return notFound();
  return withStaticHeaders(response, pathname);
}

async function serveStatic(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

  const url = new URL(request.url);

  if (url.pathname === '/') return serveAsset(request, env, '/index.html');
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return serveAsset(request, env, '/admin.html');
  }
  if (url.pathname === '/favicon.ico') {
    return new Response(null, { status: 204 });
  }

  return serveAsset(request, env, url.pathname);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const id = env.SHOP.idFromName(SHOP_NAME);
      const stub = env.SHOP.get(id);
      return stub.fetch(request);
    }

    return serveStatic(request, env);
  },
};
