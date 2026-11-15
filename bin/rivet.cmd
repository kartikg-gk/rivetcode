@echo off
if defined RIVET_NODE ("%RIVET_NODE%" --disable-warning=ExperimentalWarning "%~dp0..\dist\cli\main.js" %*) else (node --disable-warning=ExperimentalWarning "%~dp0..\dist\cli\main.js" %*)
