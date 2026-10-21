const session = require('express-session')
const { MongoStore } = require('connect-mongo')
const config = require('./config')

// HTTP와 socket.io가 같은 인스턴스를 써야 소켓에서도 로그인 유저를 찾을 수 있어 별도 파일로 분리
const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    sameSite: 'lax',
  },
  store: MongoStore.create({ mongoUrl: config.mongoUrl, dbName: config.dbName }),
})

module.exports = { sessionMiddleware }
