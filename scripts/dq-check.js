// 데이터 품질 검사를 바로 실행하고 결과를 표로 출력
// 사용법: npm run dq:check              최근 활동한 글만 확인(평소 검사)
//        npm run dq:check -- --full    모든 글 확인
const config = require('../src/config')
const db = require('../src/db')
const dataQuality = require('../src/services/dataQuality')

const LABEL = { ok: '정상', warn: '경고', fail: '실패', info: '참고' }

async function main() {
  await db.connect(config.mongoUrl, config.dbName)
  const report = await dataQuality.runChecks({ fullScan: process.argv.includes('--full') })
  await dataQuality.saveReport(report)

  console.table(
    report.checks.map((c) => ({
      상태: LABEL[c.status],
      검사: c.title,
      값: c.value,
      기준: c.threshold ?? '-',
      소요ms: c.durationMs,
    })),
  )

  for (const c of report.checks) {
    if (c.samples.length > 0) {
      console.log(`\n[${LABEL[c.status]}] ${c.title}`)
      console.table(c.samples)
    }
  }
  console.log(`\n전체 소요 시간: ${report.durationMs}ms`)
  await db.close()
}

main().catch(async (err) => {
  console.error(err)
  await db.close()
  process.exit(1)
})
