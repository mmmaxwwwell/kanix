{
  description = "Kanix Customer Flutter app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            flutter
          ];

          # Workaround: nixpkgs flutter package ships flutter_tester without
          # execute permission.  Build a thin symlink-farm overlay that copies
          # only that one binary and chmods it, then point FLUTTER_ROOT there.
          shellHook = ''
            _flutter_store="${pkgs.flutter}"
            _ft="$_flutter_store/bin/cache/artifacts/engine/linux-x64/flutter_tester"
            if [ -f "$_ft" ] && [ ! -x "$_ft" ]; then
              _patched="$PWD/.flutter-patched"
              if [ ! -x "$_patched/bin/cache/artifacts/engine/linux-x64/flutter_tester" ]; then
                chmod -R u+w "$_patched" 2>/dev/null; rm -rf "$_patched" 2>/dev/null
                mkdir -p "$_patched"
                for f in "$_flutter_store"/*; do
                  bname=$(basename "$f")
                  [ "$bname" != "bin" ] && ln -sf "$f" "$_patched/$bname"
                done
                mkdir -p "$_patched/bin"
                ln -sf "$_flutter_store/bin/flutter" "$_patched/bin/flutter"
                ln -sf "$_flutter_store/bin/dart" "$_patched/bin/dart" 2>/dev/null
                mkdir -p "$_patched/bin/cache"
                for f in "$_flutter_store/bin/cache/"*; do
                  bname=$(basename "$f")
                  [ "$bname" != "artifacts" ] && ln -sf "$f" "$_patched/bin/cache/$bname"
                done
                mkdir -p "$_patched/bin/cache/artifacts"
                for d in "$_flutter_store/bin/cache/artifacts/"*; do
                  bname=$(basename "$d")
                  [ "$bname" != "engine" ] && ln -sf "$d" "$_patched/bin/cache/artifacts/$bname"
                done
                mkdir -p "$_patched/bin/cache/artifacts/engine"
                for d in "$_flutter_store/bin/cache/artifacts/engine/"*; do
                  bname=$(basename "$d")
                  [ "$bname" != "linux-x64" ] && ln -sf "$d" "$_patched/bin/cache/artifacts/engine/$bname"
                done
                mkdir -p "$_patched/bin/cache/artifacts/engine/linux-x64"
                for f in "$_flutter_store/bin/cache/artifacts/engine/linux-x64/"*; do
                  bname=$(basename "$f")
                  if [ "$bname" = "flutter_tester" ]; then
                    cp "$f" "$_patched/bin/cache/artifacts/engine/linux-x64/$bname"
                    chmod +x "$_patched/bin/cache/artifacts/engine/linux-x64/$bname"
                  else
                    ln -sf "$f" "$_patched/bin/cache/artifacts/engine/linux-x64/$bname"
                  fi
                done
              fi
              export FLUTTER_ROOT="$_patched"
            fi
          '';
        };
      }
    );
}
