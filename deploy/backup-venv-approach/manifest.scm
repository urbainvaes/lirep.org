;; Development/deployment environment for lirep.org on Guix.
;;
;;   guix shell -m deploy/backup-venv-approach/manifest.scm
;;
;; `python-chess` is the one backend dependency I am not sure is in your Guix
;; channels; if `guix shell` complains, remove it from the list below and run
;; `pip install --user chess` (or use a venv with --system-site-packages).
(specifications->manifest
 '("python"
   "python-fastapi"
   "python-uvicorn"
   "python-httpx"
   "python-dotenv"
   "python-itsdangerous"
   "python-chess"
   "node"
   "nginx"))
