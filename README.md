# HWP 뷰어

브라우저(Chrome / Edge)에서 한글 문서(`.hwp`, `.hwpx`)를 열고, 편집하고, 같은 형식으로 저장하는 도구입니다.
설치나 서버가 필요 없고, 문서는 브라우저 안에서만 처리되며 어디에도 업로드되지 않습니다.

## 사용

- 웹: GitHub Pages 주소로 접속
- 로컬: `index.html` 을 Chrome 또는 Edge 로 열기

## 기능

- 보기: 글자 모양, 문단 모양, 표(셀 병합·테두리·배경), 그림, 각주
- 편집 (`Ctrl+E`): 텍스트 입력/문단 나누기, 표 행·열 추가/삭제, 표 선을 끌어 열 폭·행 높이 조절,
  글자 크기·굵게, 글자 서식 복사, 셀 서식 복사
- 저장 (`Ctrl+S`): 원래 형식(.hwp / .hwpx)으로 저장 — 편집한 부분만 다시 쓰고 나머지는 원본 그대로 유지

## 배포

`main` 브랜치에 push 하면 GitHub Actions(`.github/workflows/pages.yml`)가 `index.html`, `css/`, `js/` 만
GitHub Pages 로 배포합니다. 처음 한 번 저장소의 **Settings → Pages → Source** 를 **GitHub Actions** 로 지정해야 합니다.

## 구조

| 파일 | 역할 |
|---|---|
| `js/container.js` | CFB(OLE)/ZIP 읽기·쓰기, 압축 |
| `js/hwp.js`, `js/hwpx.js` | HWP 5.0 / HWPX 파서 |
| `js/render.js` | 화면 렌더링 |
| `js/editor.js` | 편집 (텍스트·표·서식) |
| `js/writer-hwp.js`, `js/writer-hwpx.js` | 저장 |
| `js/app.js` | 도구 모음, 열기/저장 |
