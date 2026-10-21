const path = require('path')
const express = require('express')
const passport = require('passport')
const methodOverride = require('method-override')
const { sessionMiddleware } = require('./session')
const { boardName } = require('./boards')

require('./auth/passport')

// toLocaleString은 호출마다 포맷 객체를 새로 만들어 느림(호출당 약 0.05ms). 한 번 만들어 재사용(약 0.001ms)
const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

function formatDate(date) {
  return dateFormatter.format(new Date(date))
}

function createApp() {
  const app = express()

  app.set('view engine', 'ejs')
  app.set('views', path.join(__dirname, '..', 'views'))

  app.use(express.static(path.join(__dirname, '..', 'public')))
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  // HTML form에서 PATCH, DELETE를 쓰기 위함
  app.use(methodOverride('_method'))

  app.use(sessionMiddleware)
  app.use(passport.initialize())
  app.use(passport.session())

  app.use((req, res, next) => {
    res.locals.currentUser = req.user ?? null
    res.locals.boardName = boardName
    res.locals.formatDate = formatDate
    next()
  })

  app.use('/', require('./routes/auth'))
  app.use('/', require('./routes/posts'))
  app.use('/', require('./routes/interactions'))
  app.use('/', require('./routes/events'))
  app.use('/', require('./routes/stream'))
  app.use('/', require('./routes/chat'))

  app.use((req, res) => {
    res.status(404).render('error', { message: '페이지를 찾을 수 없습니다.' })
  })

  // HttpError는 메시지를 그대로 보여주고, 예상하지 못한 에러는 내용을 숨기고 로그에만 남김
  app.use((err, req, res, next) => {
    const status = err.status || 500
    if (status >= 500) console.error(err)
    const message = err.expose ? err.message : '서버 오류가 발생했습니다.'

    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(status).json({ message })
    }
    res.status(status).render('error', { message })
  })

  return app
}

module.exports = { createApp }
