'use strict';

// 微信公众号授权登录路由。
// 只有 lib/wechat-auth.js 判定可用时才会跳转微信；未启用时直接回到
// 登录页，不返回“未配置”之类的提示，避免干扰本机登录流程。

const express = require('express');

function redirectAuthError(res, message) {
  res.redirect('/?authError=' + encodeURIComponent(message));
}

function createWechatAuthRouter(deps) {
  const {
    wechatAuth,
    findUserByOpenid,
    createUser,
    addUser,
    saveUsers,
    userById,
    issueUserToken,
    publicUser,
  } = deps;

  const router = express.Router();

  router.get('/wechat/start', (req, res) => {
    if (!wechatAuth.enabled) return res.redirect('/');

    const url = wechatAuth.createAuthorizeUrl(req);
    if (!url) return res.redirect('/');

    res.redirect(url);
  });

  router.get('/wechat/callback', async (req, res) => {
    if (!wechatAuth.enabled) return res.redirect('/');

    const state = String(req.query.state || '');
    if (!wechatAuth.consumeState(state)) {
      return redirectAuthError(res, '登录状态已过期，请重新登录');
    }

    const code = String(req.query.code || '');
    if (!code) {
      return redirectAuthError(res, '已取消微信登录');
    }

    try {
      const profile = await wechatAuth.exchangeCode(code);

      let user = findUserByOpenid(profile.openid);

      if (!user) {
        user = createUser({
          openid: profile.openid,
          prefillNickname: profile.nickname,
          prefillAvatar: profile.avatar,
        });
        addUser(user);
      }

      saveUsers();

      // 不把本系统 token 放进 URL，使用一次性登录码中转
      const loginCode = wechatAuth.createLoginCode(user.id);
      res.redirect('/?loginCode=' + encodeURIComponent(loginCode));
    } catch (err) {
      console.error('[微信登录] 授权失败', err.message);
      redirectAuthError(res, '微信登录失败，请稍后重试');
    }
  });

  router.post('/exchange', (req, res) => {
    const code = String((req.body && req.body.code) || '');
    const userId = wechatAuth.consumeLoginCode(code);

    if (!userId) {
      return res
        .status(400)
        .json({ error: '登录凭证已过期，请重新登录' });
    }

    const user = userById(userId);
    if (!user) {
      return res.status(404).json({ error: '账号不存在' });
    }

    const token = issueUserToken(user);

    res.json({
      mode: 'wechat',
      token,
      user: publicUser(user),
    });
  });

  return router;
}

module.exports = { createWechatAuthRouter };
