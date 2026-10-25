# Third-party notices

The packaged app includes `THIRD_PARTY_LICENSES.txt` beside this file, generated
from its bundled JavaScript, CSS, and fonts. It preserves the dependencies'
copyright notices and license texts, including the Geist fonts' SIL Open Font
License. Electron and Chromium carry their own bundled license files.

HeroUI Pro remains the property of NextUI Inc. and is used under the developer's
commercial license. It is not covered by RN Devtools' MIT license. Building from
source requires a separate HeroUI Pro license; the app distribution contains no
licensed package archive, source maps, or authentication tokens. See
<https://heroui.pro/terms> for the published terms.

## SimSlim

The bundled simulator helper includes and links the complete non-test root Go
package and license from SimSlim v0.12.2 commit
`6518ba7eab1123d7e1d7797b0e05f51043b42a5b`, with the separately recorded
patch set `rndevtools.1`. That patch narrows clone process inspection, preserves boot
state during cancelled disk cleanup, and exports SimSlim's existing launchd
status parser for the bounded adapter. SimSlim's CLI, GUI, and their unrelated
dependencies are not included. The upstream base, exact patch, and final
vendored tree each have an anchored SHA-256 manifest under
`native/rndevtools-sim-helper`.

Source: <https://github.com/MobAI-App/simslim>

MIT License

Copyright (c) 2026 Interlap

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Go runtime and standard library

`rndevtools-sim-helper` and `rndevtools` target the Go 1.27 toolchain line and contain
portions of the Go runtime and standard library. `rndevtools` is original
first-party code and incorporates no additional third-party module.

Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
- Neither the name of Google LLC nor the names of its contributors may be used
  to endorse or promote products derived from this software without specific
  prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
