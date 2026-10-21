// 최근 이벤트를 표로 출력(수집 확인용)
// 사용법: npm run events:recent            최근 20개
//        npm run events:recent -- 50       최근 50개
const config = require('../src/config')
const db = require('../src/db')

async function main() {
  const limit = Number(process.argv[2]) || 20
  await db.connect(config.mongoUrl, config.dbName)

  const events = await db
    .getDb()
    .collection('events')
    .find({})
    .sort({ _id: -1 })
    .limit(limit)
    .toArray()

  const short = (id) => (id ? String(id).slice(-6) : '-')
  console.table(
    events.map((e) => ({
      받은시각: e.receivedAt.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }),
      종류: e.type,
      출처: e.source,
      화면: e.surface ?? '-',
      위치: e.position ?? '-',
      유저: short(e.userId),
      글: short(e.postId),
      검색어: e.meta?.query ?? '-',
    })),
  )

  const counts = await db
    .getDb()
    .collection('events')
    .aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    .toArray()
  console.log('전체 이벤트 수:', Object.fromEntries(counts.map((c) => [c._id, c.count])))

  await db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
