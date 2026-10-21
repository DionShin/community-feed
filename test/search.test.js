const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, signup } = require('./helpers')

let app
let alice

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
})

after(async () => {
  await app.close()
})

beforeEach(async () => {
  await app.db.getDb().collection('events').deleteMany({})
})

async function createPost(title, content = '내용') {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', title)
  body.append('content', content)
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: alice }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

const search = async (q, cookie) =>
  (await fetch(`${app.baseUrl}/search?q=${encodeURIComponent(q)}`, { headers: cookie ? { cookie } : {} })).text()

test('제목이나 내용에 검색어가 있는 글을 찾음', async () => {
  await createPost('강남역 맛집 추천', '파스타가 맛있어요')
  await createPost('주말 등산 모임', '북한산 같이 가요')
  await createPost('질문 있어요', '강남역 근처 카페 아시나요')

  const html = await search('강남역')
  assert.match(html, /강남역 맛집 추천/)
  assert.match(html, /질문 있어요/)
  assert.doesNotMatch(html, /주말 등산 모임/)
  assert.match(html, /'강남역' 검색 결과 2건/)
})

test('정규식 특수문자는 글자 그대로 검색함', async () => {
  await createPost('C++ 공부 시작', '포인터가 어려워요')
  await createPost('Cxx 아님', '전혀 다른 글')

  const html = await search('C++')
  assert.match(html, /C\+\+ 공부 시작/)
  assert.doesNotMatch(html, /Cxx 아님/)
})

test('삭제된 글은 검색되지 않음', async () => {
  const id = await createPost('삭제될 검색대상 글')
  await fetch(`${app.baseUrl}/posts/${id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: alice } })

  assert.match(await search('검색대상'), /검색 결과가 없습니다/)
})

test('검색어와 결과 개수를 이벤트로 남김', async () => {
  await createPost('이벤트 확인용 검색 글')
  await search('확인용', alice)
  await search('없는검색어')

  const events = await app.db.getDb().collection('events').find({ type: 'search' }).sort({ _id: 1 }).toArray()
  assert.deepEqual(
    events.map((e) => [e.meta.query, e.meta.resultCount, e.userId === null, e.surface]),
    [
      ['확인용', 1, false, 'search'],
      ['없는검색어', 0, true, 'search'],
    ],
  )
})

test('빈 검색어는 안내 문구를 보여주고 이벤트를 남기지 않음', async () => {
  const html = await search('   ')
  assert.match(html, /검색어를 입력해 주세요/)
  assert.equal(await app.db.getDb().collection('events').countDocuments({ type: 'search' }), 0)
})

test('검색 결과에서의 노출과 클릭은 검색 화면 출처로 기록됨', async () => {
  const id = await createPost('출처 확인용 글')
  const html = await search('출처 확인용')
  assert.match(html, /data-surface="search"/)
  assert.match(html, new RegExp(`href="/posts/${id}\\?from=search"`))

  await fetch(`${app.baseUrl}/posts/${id}?from=search`)
  assert.ok(await app.db.getDb().collection('events').findOne({ type: 'view', surface: 'search' }))

  const res = await fetch(`${app.baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [{ type: 'impression', postId: String(id), surface: 'search', position: 0, occurredAt: new Date().toISOString() }],
    }),
  })
  assert.deepEqual(await res.json(), { accepted: 1, rejected: 0 })
})

test('검색 이벤트는 인기 점수에 영향을 주지 않음', async () => {
  const popularScoring = require('../src/services/scoring')
  assert.equal(popularScoring.SCORED_TYPES.includes('search'), false)
})
