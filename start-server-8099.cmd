@echo off
cd /d D:\code\PROJECT
set SERVER_PORT=8099
set CORS_ORIGIN=http://localhost:8089,http://127.0.0.1:8089
call npm.cmd run build --workspace @agent-cluster/server > server-8099.out.log 2> server-8099.err.log
call npm.cmd run start --workspace @agent-cluster/server >> server-8099.out.log 2>> server-8099.err.log
