{ pkgs, ... }:

{
  packages = with pkgs; [
    go
    gopls
    golangci-lint
    nodejs
    pnpm_10
    ffmpeg
    shellcheck
    shfmt
    hadolint
  ];
}
