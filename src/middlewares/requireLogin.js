// 화면 요청은 로그인 페이지로, API 요청은 401 JSON으로 응답
module.exports = function requireLogin(req, res, next) {
  if (req.isAuthenticated()) return next()

  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ message: '로그인이 필요합니다.' })
  }
  return res.redirect('/login')
}
