{ pkgs, ... }:

let
  go1269 = pkgs.go_1_26.overrideAttrs (final: previous: {
    version = "1.26.9";
    src = pkgs.fetchurl {
      url = "https://go.dev/dl/go1.26.9.src.tar.gz";
      hash = "sha256-lzXX3Ntls10/pXfwQGRzfAO4nPGitx5uaf4vPG+f1Mo=";
    };
  });
in
{
  packages = with pkgs; [
    go1269
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
