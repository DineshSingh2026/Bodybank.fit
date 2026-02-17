@echo off
REM Opens bodybank.db in DB Browser for SQLite
set "DB=c:\Users\dinesht\Desktop\bb sai gompa 16 feb\BB Volume 1\bodybank-deploy\data\bodybank.db"
set "EXE="

if exist "C:\Program Files\DB Browser for SQLite\DB Browser for SQLite.exe" set "EXE=C:\Program Files\DB Browser for SQLite\DB Browser for SQLite.exe"
if exist "C:\Program Files (x86)\DB Browser for SQLite\DB Browser for SQLite.exe" set "EXE=C:\Program Files (x86)\DB Browser for SQLite\DB Browser for SQLite.exe"
if exist "%LocalAppData%\Programs\DB Browser for SQLite\DB Browser for SQLite.exe" set "EXE=%LocalAppData%\Programs\DB Browser for SQLite\DB Browser for SQLite.exe"

if defined EXE (
    start "" "%EXE%" "%DB%"
) else (
    echo DB Browser for SQLite not found in standard locations.
    echo Open DB Browser manually, then File -^> Open Database -^> select:
    echo %DB%
    echo.
    start "" "c:\Users\dinesht\Desktop\bb sai gompa 16 feb\BB Volume 1\bodybank-deploy\data"
    pause
)
