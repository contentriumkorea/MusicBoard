MusicBoard uses Mediabunny 1.61.0 by Vanilagy for incremental media decoding.

Mediabunny is licensed under the Mozilla Public License 2.0. The license is included in licenses/mediabunny-MPL-2.0.txt.

The unmodified original TypeScript sources and license for the exact bundled version are available at:
https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz
Project: https://github.com/Vanilagy/mediabunny

The application bundles Mediabunny into its lazy-loaded waveform module; no Mediabunny source files are modified. Application waveform code is separate.

The native application also uses Tauri, Lofty, Symphonia, tiny_http, reqwest,
and their Rust dependencies. Exact resolved versions, copyright and license
notices are bundled under licenses/native-dependencies/INDEX.md and its
per-dependency license files. Symphonia is used unmodified under MPL-2.0;
the exact crate source for each bundled version is linked in that index.
The application's Rust source is separate from these dependencies.
