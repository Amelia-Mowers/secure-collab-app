{
  description = "Secure Collaborative Workspace over Matrix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Rust toolchain with WASM support built-in
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = [ "wasm32-unknown-unknown" ];
        };

        # Native build inputs
        nativeBuildInputs = with pkgs; [
          rustToolchain
          pkg-config

          # WASM tooling
          wasm-pack
          wasm-bindgen-cli
          binaryen # for wasm-opt

          # Node.js
          nodejs_20

          # System libraries
          openssl
          sqlite

          # Test Matrix homeserver
          matrix-conduit
        ];

        # Runtime libraries
        buildInputs = with pkgs; [
          openssl
          sqlite
        ] ++ lib.optionals stdenv.isDarwin [
          darwin.apple_sdk.frameworks.Security
          darwin.apple_sdk.frameworks.SystemConfiguration
        ];

      in
      {
        devShells.default = pkgs.mkShell {
          inherit buildInputs nativeBuildInputs;

          # Environment variables
          RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
          RUST_BACKTRACE = "1";

          shellHook = ''
            echo "🔐 Secure Collaborative Workspace Development Environment"
            echo ""
            echo "Rust: $(rustc --version)"
            echo "Node: $(node --version)"
            echo "wasm-pack: $(wasm-pack --version)"
            echo ""

            # Auto-install UI dependencies if needed
            if [ ! -d "ui/node_modules" ]; then
              echo "📦 Installing UI dependencies..."
              (cd ui && npm install) || echo "⚠️  Failed to install UI deps. Run: cd ui && npm install"
              echo ""
            fi

            echo "Available commands:"
            echo "  make build     - Build Rust crates"
            echo "  make test      - Run tests"
            echo "  make wasm      - Build WASM modules"
            echo "  make dev       - Start dev server"
            echo "  make help      - Show all commands"
            echo ""
            echo "✅ Environment ready! WASM target and tooling pre-installed."
            echo ""
          '';
        };
      }
    );
}
