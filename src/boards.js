// 자주 바뀌지 않아 DB 대신 코드로 관리
const BOARDS = [
  { id: 'free', name: '자유' },
  { id: 'question', name: '질문' },
  { id: 'info', name: '정보' },
  { id: 'hobby', name: '취미' },
]

const BOARD_IDS = new Set(BOARDS.map((b) => b.id))

function isValidBoard(id) {
  return BOARD_IDS.has(id)
}

function boardName(id) {
  return BOARDS.find((b) => b.id === id)?.name ?? id
}

module.exports = { BOARDS, isValidBoard, boardName }
