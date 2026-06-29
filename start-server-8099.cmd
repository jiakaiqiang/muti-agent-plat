@echo off
cd /d D:\demo\muti-agent\muti-agent-plat
set SERVER_PORT=8089
set CORS_ORIGIN=http://localhost:8099,http://127.0.0.1:8099
call npm.cmd run build --workspace @agent-cluster/server > server-8089.out.log 2> server-8089.err.log
call npm.cmd run start --workspace @agent-cluster/server >> server-8089.out.log 2>> server-8089.err.log
