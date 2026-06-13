# mdEditor

Tauri 2 기반의 단일 실행 파일(exe) 마크다운/HTML 에디터.

## 주요 기능

- **왼쪽 탐색기**: 파일/폴더를 창으로 드래그앤드롭하면 목록에 추가. 폴더는 트리로 탐색.
- **탭 편집**: 파일별 탭. 탭 우클릭 → 닫기 / 왼쪽 전체 닫기 / 오른쪽 전체 닫기 / 이 파일 제외 전체 닫기 / 전체 닫기.
- **2분할**: 탭을 편집 영역 오른쪽 절반으로 드래그하면 화면이 좌우로 분할. 가운데 구분선으로 비율 조절.
- **마크다운 하이브리드 편집**: 렌더링된 모습으로 보이다가, 블록을 클릭하면 해당 블록만 원본 마크다운으로 편집. (Esc 취소, Ctrl+Enter 또는 바깥 클릭으로 확정)
- **YAML frontmatter**: 문서가 `---`로 시작하면 머리말을 key/value 표로 렌더링. 클릭하면 원본 편집.
- **HTML 위지윅 편집**: 브라우저로 본 것처럼 렌더링되고, 클릭한 요소만 직접 편집(contenteditable).
- **단축키**: `Ctrl+S` 저장 · `Ctrl+F` 찾기 · `Ctrl+R` 찾기+바꾸기 · `Ctrl+W` 탭 닫기
- **외부 변경 감지**: 열린 파일이 밖에서 수정되면 "다시 로드할까요?" 안내.
- 폰트 크기 조절(A− / A+), 다크/라이트 모드 토글.

## 빌드

요구 사항: Rust(MSVC), Windows 10/11 (WebView2 런타임 — Win11 기본 내장)

```powershell
cd src-tauri
cargo build --release
# 결과물: src-tauri\target\release\md-editor.exe (단일 파일)
```

## 구조

```
src/                # 프론트엔드 (HTML/CSS/JS, 빌드 시 exe에 내장됨)
  main.js           # 전체 UI 로직
  vendor/marked.min.js
src-tauri/          # Rust 백엔드 (파일 IO, 변경 감지용 stat)
  src/main.rs
  tauri.conf.json
```

## 참고

- 바꾸기(Ctrl+R)는 파일 원본 텍스트 기준으로 동작합니다. HTML 파일에서는 태그 문자열도 대상이 될 수 있으니 주의하세요.
- 설정(테마, 폰트 크기, 탐색기 목록)은 자동 저장됩니다.


222222