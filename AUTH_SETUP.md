# 飞书企业授权部署说明

本项目使用融合云 FaaS 上的 `feishu-login-backend`（`media-manager-auth-backend/feishu-login-backend/`）在服务端完成飞书 OAuth 授权码校验，并只向指定飞书企业成员签发 Firebase 登录令牌。`functions/` 目录仅保留 Firestore 安全规则，不再承担登录逻辑。

## 1. 已轮换泄露的飞书密钥

旧版 `index.html` 曾把飞书 App Secret 直接写在前端代码里。该 Secret 已在飞书开放平台重新生成，前端不再持有任何飞书密钥。

## 2. 后端环境变量（融合云 FaaS）

在 `media-manager-auth-backend/feishu-login-backend/` 目录下，通过 `faascli fn config --env <env> --set-secret KEY=VALUE` 配置：

- `FIREBASE_SERVICE_ACCOUNT`：Firebase 项目 `newnew-cc905` 的服务账号 JSON（用于签发 Custom Token）。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书应用凭证。
- `FEISHU_TENANT_KEY`：获准访问的飞书企业 `tenant_key`。可通过已知属于该企业的测试账号完成一次 OAuth，从后端日志（`faascli fn diagnose logs`）中的拒绝记录读取实际返回的 tenant key，确认无误后再设置。
- `APP_ORIGIN`：生产页面地址，当前为 `https://chishuang0223-svg.github.io/media-manager/`。
- `BACKEND_PUBLIC_URL`：后端自身的公开访问地址（用于拼接飞书回调地址），当前为 `https://lfc-h2io5cym.cnhb01-dev.fc.chj.cloud`。

## 3. 配置飞书回调地址与权限

在飞书开放平台为该应用登记以下重定向地址（必须完整匹配）：

```text
https://lfc-h2io5cym.cnhb01-dev.fc.chj.cloud/completeFeishuLogin
```

同时确保已开通用户身份信息所需的 `contact:user.base:readonly` 权限，并完成飞书侧的发布/审批流程。

## 4. 部署后端和数据规则

后端部署（融合云 FaaS）：

```bash
cd media-manager-auth-backend/feishu-login-backend
faascli fn deploy --env dev
```

Firestore 规则部署（Firebase）：

```bash
npx firebase-tools deploy --only firestore:rules --config functions/firebase.json --project newnew-cc905
```

- `startFeishuLogin` / `completeFeishuLogin`（融合云后端）：生成 OAuth state 和 PKCE challenge、跳转飞书授权页、校验 state、交换授权码、验证 `tenant_key`，然后签发 Firebase Custom Token。
- `firestore.rules`：拒绝匿名访问，只允许有 `mediaManagerAccess: true` 声明的 Firebase 用户读写系统数据。

## 5. 发布网页与验证

后端和规则部署成功后，将 `index.html` 推送到 GitHub Pages。验证方式：

1. 首次访问仅显示"飞书登录"；在 URL 添加任意 `#firebaseCustomToken=` 不应绕过真实登录（无效 token 会被 Firebase Auth 拒绝）。
2. 目标飞书企业成员完成授权后能够读取、编辑和实时同步数据。
3. 非目标企业成员在回调页收到"没有访问权限"（后端日志 `tenantKey` 字段会记录实际返回值，便于核对）。
4. 未登录状态下直接访问 Firestore 数据应得到 `permission-denied`。

## 历史暴露处置

轮换 Secret 后，仍应评估将 GitHub 仓库设为私有，并清理包含 Secret 与资源明细的历史提交。轮换凭据能阻止旧 Secret 继续被使用；历史清理可降低已公开业务数据持续被发现的概率。
