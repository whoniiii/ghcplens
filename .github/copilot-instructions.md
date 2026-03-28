# Copilot Instructions — GitHub Copilot Lens

## 📌 프로젝트 개요
- **이름**: GitHub Copilot Lens (ghcpstudio)
- **목적**: Copilot CLI 세션을 실시간 모니터링하는 경량 웹 대시보드
- **기술 스택**: Node.js (프레임워크 없음, 순수 http 모듈), Vanilla JS/CSS 인라인 HTML SPA
- **⚠️ React/TypeScript 사용 안 함** — 순수 JavaScript, 단일 HTML 파일
- **포트**: 3002
- **데이터 소스**: `~/.copilot/session-state/` 디렉토리 (events.jsonl, workspace.yaml 등)
- **테스트**: Vitest (92개 테스트)

## 📁 프로젝트 구조
```
ghcpstudio/
├── public/              ← 정적 파일 (프론트엔드)
│   ├── index.html       ← 메인 대시보드 SPA (CSS+JS 인라인, ~1200줄)
│   └── logs.html        ← 로그 뷰어
├── src/                 ← 서버 소스 (백엔드)
│   └── server.js        ← Node.js HTTP 서버 (~700줄)
├── __tests__/           ← 테스트
│   └── server.test.js   ← 92개 Vitest 테스트
├── package.json
├── vitest.config.js
└── .gitignore
```

## 🔌 API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/sessions` | 모든 세션 목록 (상태, 통계 포함) |
| GET | `/api/sessions/:id` | 세션 상세 (턴, 도구, 파일, 체크포인트 등) |
| GET | `/api/sessions/:id/agents` | 서브에이전트 목록 (멀티에이전트 세션용) |
| POST | `/api/launch-vscode` | VSCode 열기 |

## 🎨 프론트엔드 특징
- **i18n**: 4개 언어 (ko/en/ja/zh), `t(key)` 함수로 번역
- **테마**: 4개 (light/gray/dark/black), CSS 변수 기반
- **레이아웃**: 2~3패널 분할 (세션 목록 | 상세 | 에이전트)
- **폴링**: 1/3/5/10초 간격 선택 가능

## 🚨 Git 작업 제한 (최우선 규칙)

**Git 관련 작업은 반드시 인간의 명시적 허락을 받은 후에만 수행합니다.**

금지 목록 (허락 없이 절대 불가):
- `git commit`, `git push`, `git merge`, `git rebase`, `git reset`
- `git branch -d`, `git tag`, `git stash drop`

허락 없이 가능한 것:
- `git status`, `git diff`, `git log` — 조회성 명령
- `git add` — 스테이징
- `git branch` — 브랜치 목록 확인

## 🤖 에이전트 기반 워크플로

### 팀 구성
| 에이전트 | 역할 | 담당 파일 |
|----------|------|-----------|
| pm | 🧠 프로젝트 매니저 — 고객 창구, 작업 분배 | README.md, 문서류 |
| ui-developer | 🎨 프론트엔드 — Vanilla JS/CSS UI | `public/*.html` |
| backend-developer | 🦾 백엔드 — Node.js 서버 API | `src/server.js` |
| tester | 🔬 테스트 — Vitest 단위/통합 테스트 | `__tests__/*.test.js` |
| infra-engineer | ⚡ 인프라 — CI/CD, 배포 | `.github/workflows/` |

### 커뮤니케이션 규칙
- **고객 → PM → 에이전트** (고객은 PM에게만 말함)
- **에이전트 → PM → 고객** (에이전트는 PM에게 보고)

## 🛠️ 개발 규칙

### 언어
- 고객이 한국어로 말하면 → 한국어로 응답
- 고객이 영어로 말하면 → 영어로 응답

### 코드 컨벤션
- **순수 JavaScript** (TypeScript 아님)
- 프론트엔드: `public/index.html`에 CSS+JS 인라인 (단일 파일 SPA)
- 백엔드: `src/server.js` — Node.js 순수 http 모듈 (Express 아님)
- i18n: 모든 UI 텍스트는 `t(key)` 함수 사용
- CSS: CSS 변수(`var(--accent)` 등)로 테마 지원

### 파일 수정 범위
- 각 에이전트는 자기 영역만 수정
- PM은 문서류만 수정 (코드 직접 수정 금지)
