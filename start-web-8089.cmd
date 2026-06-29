@echo off
cd /d D:\code\PROJECT
set VITE_API_BASE_URL=http://127.0.0.1:8099/api
set VITE_SSE_BASE_URL=http://127.0.0.1:8099/api
call npm.cmd run dev --workspace @project/web -- --port 8089 > web-8089.out.log 2> web-8089.err.log
