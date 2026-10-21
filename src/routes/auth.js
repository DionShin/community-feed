const router = require('express').Router()
const passport = require('passport')
const bcrypt = require('bcrypt')
const { getDb } = require('../db')

const USERNAME_RULE = /^[a-z0-9]{4,20}$/

function validateRegister({ username, password, nickname }) {
  if (!USERNAME_RULE.test(username)) return '아이디는 영문 소문자와 숫자 4~20자입니다.'
  if (password.length < 8) return '비밀번호는 8자 이상입니다.'
  if (nickname.length < 2 || nickname.length > 12) return '닉네임은 2~12자입니다.'
  return null
}

router.get('/register', (req, res) => {
  res.render('register', { error: null })
})

router.post('/register', async (req, res, next) => {
  const input = {
    username: String(req.body.username ?? '').trim(),
    password: String(req.body.password ?? ''),
    nickname: String(req.body.nickname ?? '').trim(),
  }

  const error = validateRegister(input)
  if (error) return res.status(400).render('register', { error })

  const passwordHash = await bcrypt.hash(input.password, 10)

  let insertedId
  try {
    const result = await getDb().collection('users').insertOne({
      username: input.username,
      passwordHash,
      nickname: input.nickname,
      createdAt: new Date(),
    })
    insertedId = result.insertedId
  } catch (err) {
    // 조회 후 저장 대신 고유 인덱스로 중복을 막음. 동시 가입 요청도 하나만 통과(11000: 중복 키)
    if (err.code === 11000) {
      return res.status(409).render('register', { error: '이미 사용 중인 아이디입니다.' })
    }
    throw err
  }

  req.login({ _id: insertedId }, (err) => {
    if (err) return next(err)
    res.redirect('/')
  })
})

router.get('/login', (req, res) => {
  res.render('login', { error: null })
})

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err)
    if (!user) return res.status(401).render('login', { error: info.message })

    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr)
      res.redirect('/')
    })
  })(req, res, next)
})

// 상태를 바꾸는 동작이라 POST로 받음
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err)
    res.redirect('/')
  })
})

module.exports = router
