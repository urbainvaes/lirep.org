;;; Guix packages for lirep.org.
;;;
;;; Use with:  guix build -L deploy/guix lirep-backend
;;;            guix shell -L deploy/guix lirep-backend

(define-module (lirep packages)
  #:use-module (guix packages)
  #:use-module (guix gexp)
  #:use-module (guix utils)
  #:use-module (guix modules)
  #:use-module (gnu packages node)
  #:use-module (gnu packages base)
  #:use-module (gnu packages compression)
  #:use-module (gnu packages nss)
  #:use-module (guix download)
  #:use-module (guix build-system pyproject)
  #:use-module (guix build-system python)
  #:use-module (guix build-system copy)
  #:use-module ((guix licenses) #:prefix license:)
  #:use-module (gnu packages)
  #:use-module (gnu packages python)
  #:use-module (gnu packages python-build)
  #:use-module (gnu packages python-web)
  #:use-module (gnu packages python-xyz)
  #:use-module (gnu packages bash))

(define-public python-chess
  (package
    (name "python-chess")
    (version "1.11.2")
    (source
     (origin
       (method url-fetch)
       (uri (pypi-uri "chess" version))
       (sha256
        (base32 "0fdv4mnvlvl2qj8yaf6awmhkfs5d2wqmgamxjl301czxg1b3xd58"))))
    (build-system pyproject-build-system)
    (arguments
     ;; The test suite expects engine binaries (Stockfish, etc.).
     (list #:tests? #f))
    (native-inputs (list python-setuptools python-wheel))
    (home-page "https://github.com/niklasf/python-chess")
    (synopsis "Chess library with move generation and validation")
    (description "python-chess is a pure Python chess library with move
generation, move validation, and support for common formats.")
    (license license:gpl3+)))

(define %repository-root
  ;; This file is <root>/deploy/guix/lirep/packages.scm.
  (dirname (dirname (dirname (dirname (canonicalize-path (search-path %load-path "lirep/packages.scm")))))))

(define %backend-source
  (local-file (string-append %repository-root "/backend") "lirep-backend-source"
              #:recursive? #t
              #:select?
              (lambda (file stat)
                (not (or (string-contains file "/.venv")
                         (string-contains file "__pycache__")
                         (string-contains file "/tests")
                         (string-suffix? ".db" file)
                         (string-contains file ".env"))))))

(define-public lirep-backend
  (package
    (name "lirep-backend")
    (version "0.0.1")
    (source %backend-source)
    (build-system copy-build-system)
    (arguments
     (list
      #:install-plan #~'(("app" "share/lirep/backend/app"))
      #:phases
      #~(modify-phases %standard-phases
          (add-after 'install 'install-launcher
            (lambda* (#:key inputs outputs #:allow-other-keys)
              (let* ((out (assoc-ref outputs "out"))
                     (bin (string-append out "/bin"))
                     (python-path (getenv "GUIX_PYTHONPATH")))
                (mkdir-p bin)
                (call-with-output-file (string-append bin "/lirep-backend")
                  (lambda (port)
                    (format port "#!~a~%export GUIX_PYTHONPATH=~a:~a/share/lirep/backend~%exec ~a -m uvicorn app.main:app --host \"${LIREP_HOST:-127.0.0.1}\" --port \"${LIREP_PORT:-8000}\" --proxy-headers --app-dir ~a/share/lirep/backend \"$@\"~%"
                            (search-input-file inputs "/bin/sh")
                            python-path out
                            (search-input-file inputs "/bin/python3")
                            out)))
                (chmod (string-append bin "/lirep-backend") #o755)))))))
    (inputs
     (list bash-minimal
           python
           python-fastapi
           python-uvicorn
           python-httpx
           python-dotenv
           python-itsdangerous
           python-chess))
    (home-page "https://lirep.org")
    (synopsis "Opening repertoire trainer: API backend")
    (description "FastAPI backend for lirep.org: studies, Explorer proxy,
statistics, and spaced-repetition practice.")
    (license license:agpl3)))

;;; Frontend ------------------------------------------------------------

(define %frontend-source
  (local-file (string-append %repository-root "/frontend") "lirep-frontend-source"
              #:recursive? #t
              #:select?
              (lambda (file stat)
                (not (or (string-contains file "/node_modules")
                         (string-contains file "/dist")
                         (string-contains file "__pycache__"))))))

;; npm needs the network, so the dependencies are fetched in a fixed-output
;; derivation.  Update the hash whenever package-lock.json changes:
;; build with a wrong hash and copy the "actual" hash from the error.
(define-public lirep-frontend-node-modules
  (computed-file
   "lirep-frontend-node-modules"
   (with-imported-modules '((guix build utils))
     #~(begin
         (use-modules (guix build utils))
         (let ((src #$(file-append %frontend-source "")))
           (setenv "HOME" (getcwd))
           (setenv "SSL_CERT_FILE" #$(file-append nss-certs "/etc/ssl/certs/ca-certificates.crt"))
           (setenv "PATH" (string-append #$(file-append node-lts "/bin") ":"
                                         #$(file-append coreutils "/bin") ":"
                                         #$(file-append bash-minimal "/bin")))
           (copy-recursively src "src-copy")
           (with-directory-excursion "src-copy"
             (invoke "npm" "ci" "--no-audit" "--no-fund" "--ignore-scripts")
             ;; Drop files that vary with the npm version (the hidden lockfile
             ;; and the .bin symlinks, which the build does not use) so that
             ;; the hash does not depend on which Guix revision builds this.
             (for-each (lambda (f)
                         (when (file-exists? f) (delete-file-recursively f)))
                       '("node_modules/.package-lock.json"
                         "node_modules/.bin"
                         "node_modules/.cache"
                         ;; Optional native addon that npm 11 installs and
                         ;; npm 10 skips; the build does not use it.
                         "node_modules/@napi-rs/lzma-linux-x64-gnu"))
             (copy-recursively "node_modules" #$output)))))
   #:options
   `(#:hash-algo sha256
     #:hash ,(base32 "1m0vccnas4nq5rzh207k9fm5x73p9y6nyn9mssljh9rwfd3hn2l2")
     #:recursive? #t)))

(define-public lirep-frontend
  (package
    (name "lirep-frontend")
    (version "0.0.1")
    (source %frontend-source)
    (build-system copy-build-system)
    (arguments
     (list
      #:install-plan #~'(("dist" "share/lirep/frontend"))
      #:phases
      #~(modify-phases %standard-phases
          (add-before 'install 'build
            (lambda* (#:key native-inputs inputs #:allow-other-keys)
              (copy-recursively #$lirep-frontend-node-modules "node_modules")
              (invoke "node" "node_modules/vite/bin/vite.js" "build"))))))
    (native-inputs (list node))
    (home-page "https://lirep.org")
    (synopsis "Opening repertoire trainer: static web frontend")
    (description "Static HTML, JavaScript and CSS for lirep.org.")
    (license license:agpl3)))
