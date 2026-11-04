export const PAPER_PANE_COPY = {
  collapse: '내 논문 접기',
  expand: '내 논문 펴기',
  unseen: '새로 볼 것이 있어요',
  tabList: '내 논문과 파일',
  paperTab: '내 논문',
  closeFile: '파일 탭 닫기',
  readOnly: '읽기 전용 미리보기',
  fileType: (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase()
    if (ext === 'xlsx' || ext === 'xlsm') return '엑셀'
    if (ext === 'docx') return '워드'
    if (ext === 'pdf') return 'PDF'
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return '그림'
    return '파일'
  },
  excelHint: '앱 안 미리보기는 읽기만 돼요. 고치려면 도우미에게 말하거나 “원래 앱으로 열기”를 누르세요.',
  outsideProject: '이 논문 폴더 밖의 파일은 열 수 없어요.',
  notFound: (name: string) => `"${name}"을 찾지 못했어요.`,
  otherFiles: '아래는 이 논문에서 만든 다른 파일이에요.'
} as const
