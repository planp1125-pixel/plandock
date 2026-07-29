# Project Rules & Customizations for Plan Terminal

## Git & Release Strategy
- Whenever pushing code changes to GitHub, ALWAYS:
  1. Update the version number in `package.json`, `Cargo.toml`, and `tauri.conf.json`.
  2. Create matching git tags for the version (e.g., `git tag v0.5.x` and `git tag app-v0.5.x`).
  3. Push tags alongside commits (`git push origin main` and `git push origin --tags`).
  4. This ensures GitHub Actions (`build.yml`) automatically compiles and publishes `.exe`, `.deb`, `.dmg`, and `.AppImage` binary packages to GitHub Releases every single time.
