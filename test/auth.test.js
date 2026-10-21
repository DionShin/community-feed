const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startTestApp, form, sessionCookie } = require('./helpers')

let app

before(async () => {
  app = await startTestApp()
})

after(async () => {
  await app.close()
})

async function homeHtml(cookie) {
  const res = await fetch(`${app.baseUrl}/`, { headers: cookie ? { cookie } : {} })
  return res.text()
}

test('회원가입하면 바로 로그인 상태가 됨', async () => {
  const res = await fetch(`${app.baseUrl}/register`, form({ username: 'alice01', password: 'password123', nickname: '앨리스' }))
  assert.equal(res.status, 302)

  const cookie = sessionCookie(res)
  assert.ok(cookie, '세션 쿠키가 있어야 한다')
  assert.match(await homeHtml(cookie), /앨리스님/)
})

test('같은 아이디로 다시 가입하면 409를 돌려줌', async () => {
  const res = await fetch(`${app.baseUrl}/register`, form({ username: 'alice01', password: 'password123', nickname: '다른사람' }))
  assert.equal(res.status, 409)
  assert.match(await res.text(), /이미 사용 중인 아이디/)
})

test('같은 아이디로 동시에 가입해도 한 명만 성공함', async () => {
  const body = { username: 'race01', password: 'password123', nickname: '동시가입' }
  const results = await Promise.all(
    Array.from({ length: 5 }, () => fetch(`${app.baseUrl}/register`, form(body))),
  )
  const statuses = results.map((r) => r.status).sort()
  assert.deepEqual(statuses, [302, 409, 409, 409, 409])
})

test('규칙에 맞지 않는 입력은 400을 돌려줌', async () => {
  const res = await fetch(`${app.baseUrl}/register`, form({ username: 'A!', password: 'short', nickname: 'x' }))
  assert.equal(res.status, 400)
})

test('없는 아이디와 틀린 비밀번호는 같은 메시지로 실패함', async () => {
  const unknown = await fetch(`${app.baseUrl}/login`, form({ username: 'nobody99', password: 'password123' }))
  const wrong = await fetch(`${app.baseUrl}/login`, form({ username: 'alice01', password: 'wrongpass1' }))

  assert.equal(unknown.status, 401)
  assert.equal(wrong.status, 401)
  const pick = (html) => html.match(/class="error-text">([^<]+)</)[1]
  assert.equal(pick(await unknown.text()), pick(await wrong.text()))
})

test('로그인 후 로그아웃하면 다시 비로그인 상태가 됨', async () => {
  const login = await fetch(`${app.baseUrl}/login`, form({ username: 'alice01', password: 'password123' }))
  assert.equal(login.status, 302)
  const cookie = sessionCookie(login)
  assert.match(await homeHtml(cookie), /앨리스님/)

  const logout = await fetch(`${app.baseUrl}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
  assert.equal(logout.status, 302)
  assert.doesNotMatch(await homeHtml(cookie), /앨리스님/)
})

test('저장된 유저 문서에는 평문 비밀번호가 없음', async () => {
  const user = await app.db.getDb().collection('users').findOne({ username: 'alice01' })
  assert.equal(user.password, undefined)
  assert.notEqual(user.passwordHash, 'password123')
  assert.match(user.passwordHash, /^\$2[aby]\$10\$/)
})
