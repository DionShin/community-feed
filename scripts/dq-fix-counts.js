// 원본과 어긋난 공감 수, 댓글 수를 바로잡음
// 사용법: npm run dq:fix-counts              고칠 목록만 출력
//        npm run dq:fix-counts -- --apply    실제로 수정
const config = require('../src/config')
const db = require('../src/db')
const dataQuality = require('../src/services/dataQuality')

async function main() {
  const apply = process.argv.includes('--apply')
  await db.connect(config.mongoUrl, config.dbName)

  const { changes } = await dataQuality.reconcileCounts({ apply })
  if (changes.length === 0) {
    console.log('어긋난 글이 없습니다.')
  } else {
    console.table(changes.map((c) => ({ 글: c.postId, 항목: c.field, 현재값: c.from, 실제값: c.to })))
    console.log(apply ? `${changes.length}건을 바로잡았습니다.` : `${changes.length}건을 고칠 수 있습니다. 실제로 고치려면 --apply를 붙이세요.`)
  }
  await db.close()
}

main().catch(async (err) => {
  console.error(err)
  await db.close()
  process.exit(1)
})
