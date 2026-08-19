const crypto = require('node:crypto');
const { fastify } = require('fastify');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  throw new Error('缺少环境变量 FIREBASE_SERVICE_ACCOUNT');
}
initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_TENANT_KEY = process.env.FEISHU_TENANT_KEY;
const APP_ORIGIN = process.env.APP_ORIGIN;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL;

const OAUTH_COOKIE_MAX_AGE = 10 * 60;

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomValue(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function sha256(value) {
  return base64Url(crypto.createHash('sha256').update(value).digest());
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) return cookies;

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function cookieString(name, value, maxAge = OAUTH_COOKIE_MAX_AGE) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function safeEqual(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function callbackUrl() {
  if (!BACKEND_PUBLIC_URL) throw new Error('缺少环境变量 BACKEND_PUBLIC_URL');
  return `${BACKEND_PUBLIC_URL.replace(/\/$/, '')}/completeFeishuLogin`;
}

function renderErrorHtml(title, message) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f7f8;padding:48px;color:#263238"><main style="max-width:560px;margin:auto;background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.12)"><h1>${title}</h1><p>${message}</p><p>请关闭此页面后重新发起登录；如问题持续，请联系系统管理员。</p></main></body></html>`;
}

async function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: FEISHU_APP_ID,
      client_secret: FEISHU_APP_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const payload = await response.json();
  const accessToken = payload.access_token || payload.data?.access_token;

  if (!response.ok || !accessToken) {
    throw new Error('飞书未接受本次授权请求');
  }

  return accessToken;
}

async function getFeishuUser(accessToken) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json();
  const user = payload.data || payload;

  if (!response.ok || payload.code !== 0 || !user.tenant_key) {
    throw new Error('无法验证飞书账号所属企业');
  }

  return user;
}

const server = fastify({
  logger: {
    level: 'info',
  },
  disableRequestLogging: false,
});

server.get('/startFeishuLogin', async (request, reply) => {
  const state = randomValue();
  const codeVerifier = randomValue(64);
  const redirectUri = callbackUrl();
  const authorizationUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');

  authorizationUrl.search = new URLSearchParams({
    app_id: FEISHU_APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'contact:user.base:readonly',
    state,
    code_challenge: sha256(codeVerifier),
    code_challenge_method: 'S256',
  }).toString();

  reply
    .header('Set-Cookie', [
      cookieString('feishu_oauth_state', state),
      cookieString('feishu_oauth_verifier', codeVerifier),
    ])
    .header('Cache-Control', 'no-store')
    .redirect(authorizationUrl.toString(), 302);
});

server.get('/completeFeishuLogin', async (request, reply) => {
  const cookies = parseCookies(request.headers.cookie);
  const code = typeof request.query.code === 'string' ? request.query.code : '';
  const state = typeof request.query.state === 'string' ? request.query.state : '';
  const error = typeof request.query.error === 'string' ? request.query.error : '';

  const clearCookies = [
    cookieString('feishu_oauth_state', '', 0),
    cookieString('feishu_oauth_verifier', '', 0),
  ];

  if (error) {
    reply
      .header('Set-Cookie', clearCookies)
      .status(401)
      .type('text/html')
      .send(renderErrorHtml('飞书授权未完成', '您取消了授权或飞书拒绝了本次请求。'));
    return;
  }

  if (!code || !safeEqual(state, cookies.feishu_oauth_state) || !cookies.feishu_oauth_verifier) {
    reply
      .header('Set-Cookie', clearCookies)
      .status(400)
      .type('text/html')
      .send(renderErrorHtml('授权请求无效', '授权状态校验失败或请求已过期。'));
    return;
  }

  try {
    const accessToken = await exchangeAuthorizationCode({
      code,
      redirectUri: callbackUrl(),
      codeVerifier: cookies.feishu_oauth_verifier,
    });
    const user = await getFeishuUser(accessToken);

    if (!safeEqual(user.tenant_key, FEISHU_TENANT_KEY)) {
      request.log.warn({ tenantKey: user.tenant_key }, '拒绝非目标企业的飞书登录');
      reply
        .header('Set-Cookie', clearCookies)
        .status(403)
        .type('text/html')
        .send(renderErrorHtml('没有访问权限', '当前飞书账号不属于获准访问本系统的企业。'));
      return;
    }

    const userId = user.open_id || user.union_id || user.user_id;
    if (!userId) {
      throw new Error('飞书用户资料缺少稳定身份标识');
    }

    const customToken = await getAuth().createCustomToken(`feishu:${userId}`, {
      mediaManagerAccess: true,
      tenantKey: user.tenant_key,
    });
    const appOrigin = new URL(APP_ORIGIN);

    if (appOrigin.protocol !== 'https:') {
      throw new Error('APP_ORIGIN 必须使用 HTTPS');
    }

    appOrigin.hash = new URLSearchParams({ firebaseCustomToken: customToken }).toString();
    reply
      .header('Set-Cookie', clearCookies)
      .header('Cache-Control', 'no-store')
      .redirect(appOrigin.toString(), 302);
  } catch (err) {
    request.log.error({ message: err.message }, '飞书登录处理失败');
    reply
      .header('Set-Cookie', clearCookies)
      .status(500)
      .type('text/html')
      .send(renderErrorHtml('登录暂时不可用', '系统无法完成本次身份验证。'));
  }
});

server.listen({ port: 8080, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
});
