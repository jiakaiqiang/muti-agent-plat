@echo off
cd /d D:\demo\muti-agent\muti-agent-plat
set VITE_API_BASE_URL=http://127.0.0.1:8089/api
set VITE_SSE_BASE_URL=http://127.0.0.1:8089/api
call npm.cmd run dev --workspace @project/web -- --port 8099 > web-8099.out.log 2> web-8099.err.log
