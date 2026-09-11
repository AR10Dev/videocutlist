{ pkgs, ... }:

{
  packages = with pkgs; [
    go
    gopls
    golangci-lint
    nodejs
    pnpm
    ffmpeg
    shellcheck
    shfmt
    hadolint
  ];
}
