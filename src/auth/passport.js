const passport = require('passport')
const LocalStrategy = require('passport-local')
const bcrypt = require('bcrypt')
const { ObjectId } = require('mongodb')
const { getDb } = require('../db')

// 아이디 없음과 비밀번호 틀림을 같은 메시지로 처리. 다르면 가입 여부가 드러남
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않습니다.'

passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      const user = await getDb().collection('users').findOne({ username })
      if (!user) return done(null, false, { message: LOGIN_FAILED })

      const ok = await bcrypt.compare(password, user.passwordHash)
      if (!ok) return done(null, false, { message: LOGIN_FAILED })

      return done(null, user)
    } catch (err) {
      return done(err)
    }
  }),
)

// 세션에는 유저 id만 저장. 바뀔 수 있는 값은 복사하지 않음
passport.serializeUser((user, done) => {
  done(null, user._id.toString())
})

// 요청마다 유저를 다시 읽음(비밀번호 해시 제외)
passport.deserializeUser(async (id, done) => {
  try {
    const user = await getDb()
      .collection('users')
      .findOne({ _id: new ObjectId(id) }, { projection: { passwordHash: 0 } })
    // 유저가 삭제됐으면 로그아웃 상태로 처리
    done(null, user || false)
  } catch (err) {
    done(err)
  }
})
