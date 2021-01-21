@rem Copyright 2020 Google LLC
@rem
@rem Use of this source code is governed by an MIT-style
@rem license that can be found in the LICENSE file or at
@rem https://opensource.org/licenses/MIT.

@echo "Starting Windows build"

cd /d %~dp0
cd ..

@rem npm path is not currently set in our image, we should fix this next time
@rem we upgrade Node.js in the image:
SET PATH=%PATH%;/cygdrive/c/Program Files/nodejs/npm

call nvm use v12.14.1
call which node

call npm install || goto :error
call npm run test || goto :error

goto :EOF

:error
exit /b 1
