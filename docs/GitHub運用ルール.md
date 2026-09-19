# GitHub運用ルール

このリポジトリは運営にも見られるので、**mainブランチへの直接pushは禁止**にします。

基本の流れは以下です。

## 1. 作業前に最新化

GitHub Desktopで **Fetch origin → Pull origin** をしてください。

## 2. 作業用ブランチを作る

GitHub Desktopの **Current Branch** から **New Branch** を押して、作業用ブランチを作ってください。

ブランチ名の例:

- `feature/field-report-ui`
- `feature/dashboard-ui`
- `feature/timeline-forecast`
- `feature/incident-flow`
- `fix/readme-text`
- `infra/docker-setup`

## 3. 作業する

VS CodeやCursorなどで編集してください。

## 4. コミットする

GitHub Desktopで変更内容を確認して、コミットしてください。

コミットメッセージは「何をしたか」が分かる名前にしてください。例:

- `Add field report layout`
- `Update dashboard cards`
- `Add timeline view`
- `Fix README wording`

コミットメッセージが決まったらコミットする前にこちらにコミットメッセージを出力して確認を取って下さい

## 5. GitHubにpushする

GitHub Desktopで **Publish branch** または **Push origin** を押してください。

## 6. Pull Requestを作る

push後に **Create Pull Request** を押して、PRを作ってください。
mainに直接入れず、PRで確認してからマージします。

---

## 【注意】

- mainに直接commit / pushしない
- 作業前は必ずFetch / Pullする
- 1つのブランチでは、なるべく1つの作業だけやる
- READMEに内部向けの作戦やデモの保険は書かない
- 動作が壊れていそうな状態ではPRに一言書く
- 分からなかったら無理に進めず聞いてください
