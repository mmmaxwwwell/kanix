{
  description = "STL normalization pipeline — parametric commands (align, scale, center, drop, inspect) composed by per-object shell scripts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Python environment shared by every command. Add packages here to
        # make them available to all commands automatically.
        pythonEnv = pkgs.python312.withPackages (ps: with ps; [
          trimesh
          numpy
          scipy
          networkx
        ]);

        # The commands/ directory is a Python package. We put its PARENT on
        # PYTHONPATH (not the package itself) so script filenames like
        # `inspect.py` don't shadow stdlib modules — running via `python -m
        # commands.<name>` resolves imports through the package.
        commandsSrc = pkgs.runCommand "stl-pipeline-commands" {} ''
          mkdir -p $out
          cp -r ${./commands} $out/commands
        '';

        # mkCmd "foo"          -> command `stl-foo`, runs `python -m commands.foo`
        # mkCmd' "show-faces" "show_faces" -> command `stl-show-faces`,
        #                                     runs `python -m commands.show_faces`
        mkCmd' = cliName: moduleName: pkgs.writeShellApplication {
          name = "stl-${cliName}";
          runtimeInputs = [ pythonEnv ];
          text = ''
            export PYTHONPATH="${commandsSrc}''${PYTHONPATH:+:$PYTHONPATH}"
            exec python -m commands.${moduleName} "$@"
          '';
        };
        mkCmd = name: mkCmd' name name;

        commands = {
          inspect     = mkCmd "inspect";
          align       = mkCmd "align";
          align-frame = mkCmd' "align-frame" "align_frame";
          rotate      = mkCmd "rotate";
          scale       = mkCmd "scale";
          center      = mkCmd "center";
          drop        = mkCmd "drop";
          show-faces  = mkCmd' "show-faces" "show_faces";
        };

        # Bundle of all commands on PATH, plus the python env, for use in
        # shell scripts under pipelines/ that compose multiple operations.
        pipelineEnv = pkgs.buildEnv {
          name = "stl-pipeline-env";
          paths = builtins.attrValues commands;
        };
      in {
        packages = commands // {
          default = pipelineEnv;
          pipeline-env = pipelineEnv;
        };

        apps = {
          inspect     = { type = "app"; program = "${commands.inspect}/bin/stl-inspect"; };
          align       = { type = "app"; program = "${commands.align}/bin/stl-align"; };
          align-frame = { type = "app"; program = "${commands.align-frame}/bin/stl-align-frame"; };
          rotate      = { type = "app"; program = "${commands.rotate}/bin/stl-rotate"; };
          scale       = { type = "app"; program = "${commands.scale}/bin/stl-scale"; };
          center      = { type = "app"; program = "${commands.center}/bin/stl-center"; };
          drop        = { type = "app"; program = "${commands.drop}/bin/stl-drop"; };
          show-faces  = { type = "app"; program = "${commands.show-faces}/bin/stl-show-faces"; };
          default     = { type = "app"; program = "${commands.inspect}/bin/stl-inspect"; };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = (builtins.attrValues commands) ++ [ pythonEnv pkgs.f3d ];
          shellHook = ''
            echo "stl-pipeline — commands on PATH:"
            echo "  stl-inspect  stl-align  stl-align-frame  stl-rotate  stl-scale  stl-center  stl-drop  stl-show-faces"
            echo "Viewer: f3d <file.ply>  (press U to reload, R to reset camera, Q to quit)"
            echo "Per-object pipelines live in ./pipelines/"
          '';
        };
      });
}
