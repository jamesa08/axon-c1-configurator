@echo off
cd /d "%~dp0frontend"
call npm install --silent
call npm run build
cd /d "%~dp0backend"
pip install -q -r requirements.txt
python launch.py
