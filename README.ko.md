# vanilla-deploy

git 저장소의 커밋된 `HEAD` 를 ssh 로 서버에 배포하는 도구입니다. `--apply` 를 붙이기 전에는 아무것도 바꾸지 않습니다(dry-run). 바뀐 파일만 보내고, 보낸 파일은 모두 해시로 확인하며, 배포마다 명령 하나로 되돌릴 수 있습니다.

의존성은 없습니다. 내 PC 에는 Node.js 내장 모듈과 `git`, `ssh` 만, 서버에는 `bash` 와 `tar` 만 있으면 됩니다. 서버에 따로 설치할 에이전트나 데몬은 없습니다.

자세한 설정표와 동작 설명은 [README.md](README.md)(영문)에 있습니다. 이 문서는 요약입니다.

## 동작 순서

1. **계획.** 로컬 `HEAD` 의 파일별 blob 해시(`git ls-tree`)와 서버 파일의 해시(git 과 같은 방식으로 계산)를 비교하고, 서버의 배포 기록도 함께 읽습니다. 그 결과로 추가·수정·삭제할 파일과 *drift*(지난 배포 뒤 서버에서 직접 바뀐 파일)를 정리합니다.
2. **백업.** 덮어쓰거나 지울 파일을 `.deploy/backups/<id>/<대상>.tgz` 에 묶어 둡니다. 새로 생길 파일·폴더 목록과 직전 배포 기록도 남깁니다.
3. **전송.** 추가·수정할 파일만 tar 스트림으로 ssh 를 통해 `tar -xf -` 에 넘깁니다. tar 는 git blob 바이트로 직접 만들기 때문에 로컬 `tar` 가 필요 없고 줄바꿈도 바뀌지 않습니다.
4. **검증.** 삭제할 파일을 지운 뒤, 보낸 파일을 서버에서 다시 해시해 blob 해시와 맞춰 봅니다. 모두 맞을 때만 배포 기록을 새로 씁니다.
5. **재시작.** 바뀐 대상의 systemd 유닛(`--user` 또는 system)을 다시 시작합니다. 유닛이 active 가 되고 main PID 가 바뀌고 health URL 이 2xx/3xx 로 답할 때까지 기다립니다.
6. **캐시 비우기**(선택). 바뀐 캐시 대상 파일을 Cloudflare 에서 URL 별로 비웁니다.
7. **정리.** `backups.keepDays` 보다 오래된 백업을 지웁니다. 가장 최근 `backups.keepMin` 개는 항상 남깁니다.

### mtime 대신 blob 해시를 쓰는 이유

mtime 은 내용이 아니라 "언제 건드렸는가"입니다. checkout, rebase, stash, 복사만 해도 바뀌므로 매번 전부 보내거나 실제 변경을 놓치기 쉽습니다. git 은 커밋된 파일마다 이미 내용 id(blob sha)를 갖고 있으니, 서버 파일도 같은 방식으로 해시하면 "바이트가 같은가"에 정확히 답할 수 있습니다. 이 해시 하나로 변경 계산, 전송 뒤 검증, 서버에서 손으로 고친 파일 찾기를 모두 합니다.

커밋된 내용만 올라갑니다. 커밋하지 않은 수정과 추적하지 않는 파일(`.env`, 로컬 데이터)은 PC 밖으로 나가지 않습니다.

## 빠른 시작

```sh
cp deploy.config.example.json deploy.config.json   # ssh · remoteRoot · targets 를 고친다
vanilla-deploy plan all                             # 무엇이 바뀌는지 보기
vanilla-deploy apply web                            # 리허설 (plan 과 같음)
vanilla-deploy apply web --apply                    # 실제 배포
vanilla-deploy list                                 # 배포 id 확인
vanilla-deploy rollback 20261127-093000 --apply     # 되돌리기
```

## 명령

| 명령 | 설명 |
|---|---|
| `plan <대상...\|all>` | 바뀔 내용만 보여 줍니다. 아무것도 쓰지 않습니다. |
| `apply <대상...\|all> [--apply]` | `--apply` 가 없으면 리허설입니다. 있으면 백업, 전송, 검증, 기록, 재시작, 캐시 비우기, 정리 순으로 진행합니다. |
| `rollback <id> [--apply]` | 그 배포가 덮어쓰거나 지운 파일을 복원하고, 만든 파일과 빈 폴더를 지우고, 직전 배포 기록을 되살립니다. |
| `list` | 대상, 대상별 현재 배포 기록, 최근 배포 id, 유닛 상태를 보여 줍니다. |
| `restart <대상...\|all> [--apply]` | 배포 없이 재시작하고 health 를 확인합니다. |
| `prune [--apply]` | 오래된 백업을 정리합니다. |
| `purge [--apply]` | Cloudflare 영역 캐시를 전부 비웁니다. |

옵션: `--apply`(실행), `--allow-dirty`(미커밋 변경이 있어도 HEAD 배포), `--force`(drift 덮어쓰기, 최신이 아닌 배포 롤백), `--no-restart`, `--no-purge`, `--config <파일>`.

## 안전 장치

- **기본은 dry-run 입니다.** 무언가를 바꾸는 명령은 모두 `--apply` 가 있어야 실행됩니다.
- **미커밋 변경이 있으면 멈춥니다.** `--apply` 는 거부되고, `--allow-dirty` 를 붙여도 `HEAD` 만 올라갑니다.
- **drift 가 있으면 멈춥니다.** `--force` 로 덮어쓸 수 있고, 덮어쓴 파일도 백업됩니다. 이 도구가 올린 적 없고 저장소에도 없는 서버 파일은 건드리지 않습니다.
- **해시 검증이 실패하면** 배포 기록을 쓰지 않고 멈추며 되돌리기 명령을 알려 줍니다.
- **롤백은 정확합니다.** 덮어쓴·지운 파일은 내용과 권한까지 복원하고, 새로 만든 파일과 빈 폴더는 지우고, 배포 기록도 되돌립니다. 같은 대상에 더 새로운 배포가 있거나 이미 되돌린 배포라면 `--force` 없이는 거부합니다.
- **경로를 검사하고 모든 값을 따옴표로 감쌉니다.** `..`, 절대 경로, 백슬래시, 제어 문자(줄바꿈, 탭 등), 앞뒤 공백이 있는 이름은 거부합니다. 조용히 건너뛰지 않고 이름을 바꾸거나 `exclude` 하라고 알려 줍니다. 공백, 따옴표, `$(...)`, 백틱, `;` 같은 문자는 작은따옴표와 따옴표 친 heredoc 으로 안전하게 넘어가며, 서버에서 다시 읽어 온 경로도 한 번 더 검사합니다.
- **비밀 값은 로그에 남지 않습니다.** Cloudflare 토큰은 환경변수에서만 읽고 출력하지 않으며, API 오류 메시지에서도 지웁니다.
- **재시도는 한정적입니다.** 키 교환 전에 끊긴 접속(`kex_exchange_identification`)만 다시 시도합니다. 이때는 원격 명령이 아직 시작되지 않았기 때문입니다. 명령이 도는 중에 끊긴 접속은 다시 시도하지 않습니다.

## Windows (PowerShell, Git Bash)

- PowerShell, cmd, Git Bash 어디서든 실행됩니다. ssh 는 Windows OpenSSH 와 Git for Windows 의 ssh 모두 쓸 수 있고, `ssh.command` 로 고를 수 있습니다.
- `-F none` 으로 `~/.ssh/config` 를 읽지 않습니다. 모르는 옵션이 하나라도 있으면 ssh 가 아예 시작하지 않는 문제를 피하기 위해서입니다.
- 커밋된 바이트를 그대로 보내므로 `core.autocrlf` 설정과 상관없이 서버 파일의 줄바꿈은 바뀌지 않습니다.
- 테스트와 `transport.type: "local"` 에는 Git for Windows 의 bash 가 필요합니다. WSL 의 bash.exe 는 쓰지 않습니다.

## 테스트

```sh
npm test
```

실제 서버가 없어도 됩니다. 임시 폴더를 서버로 삼아 실제 원격 스크립트를 로컬 bash 로 실행합니다. systemd, health, ssh 끊김, Cloudflare API 는 모두 가짜로 대신합니다.

## 라이선스

MIT ([LICENSE](LICENSE))
