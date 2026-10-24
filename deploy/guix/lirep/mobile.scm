;;; Guix package for Lirep's mobile app (mobile/), served at /m/.
;;;
;;;   guix build -L deploy/guix lirep-mobile
;;;
;;; The app shares the website's code (frontend/src, as "@web/…"), so its
;;; source is mobile/ and frontend/src/; its libraries are its own
;;; (mobile/package-lock.json). See deploy/build-mobile.sh.

(define-module (lirep mobile)
  #:use-module (guix packages)
  #:use-module (guix gexp)
  #:use-module (guix build-system copy)
  #:use-module ((guix licenses) #:prefix license:)
  #:use-module (gnu packages base)
  #:use-module (gnu packages bash)
  #:use-module (gnu packages node)
  #:use-module (gnu packages nss)
  #:use-module (srfi srfi-13))

(define %repository-root
  ;; This file is <root>/deploy/guix/lirep/mobile.scm.
  (dirname (dirname (dirname (dirname (canonicalize-path (search-path %load-path "lirep/mobile.scm")))))))

(define %mobile-source
  ;; The repository's mobile/ and frontend/src/, nothing else: a change
  ;; elsewhere doesn't rebuild the app.
  (local-file %repository-root "lirep-mobile-source"
              #:recursive? #t
              #:select?
              (lambda (file stat)
                (let ((path (string-drop file (string-length %repository-root))))
                  (and (not (string-contains path "/node_modules"))
                       (not (string-prefix? "/mobile/dist" path))
                       (or (string-null? path)
                           (string=? path "/mobile")
                           (string-prefix? "/mobile/" path)
                           (string=? path "/frontend")
                           (string=? path "/frontend/src")
                           (string-prefix? "/frontend/src/" path)))))))

;; npm needs the network, so the dependencies are fetched in a fixed-output
;; derivation, as for the website (packages.scm).  Update the hash whenever
;; mobile/package-lock.json changes: build with a wrong hash and copy the
;; "actual" hash from the error.
(define-public lirep-mobile-node-modules
  (computed-file
   "lirep-mobile-node-modules"
   (with-imported-modules '((guix build utils))
     #~(begin
         (use-modules (guix build utils))
         (setenv "HOME" (getcwd))
         (setenv "SSL_CERT_FILE" #$(file-append nss-certs "/etc/ssl/certs/ca-certificates.crt"))
         (setenv "PATH" (string-append #$(file-append node-lts "/bin") ":"
                                       #$(file-append coreutils "/bin") ":"
                                       #$(file-append bash-minimal "/bin")))
         (copy-recursively #$(file-append %mobile-source "/mobile") "src-copy")
         (with-directory-excursion "src-copy"
           (invoke "npm" "ci" "--no-audit" "--no-fund" "--ignore-scripts")
           ;; Files that vary with the npm version, unused by the build.
           (for-each (lambda (f)
                       (when (file-exists? f) (delete-file-recursively f)))
                     '("node_modules/.package-lock.json"
                       "node_modules/.bin"
                       "node_modules/.cache"
                       "node_modules/@napi-rs/lzma-linux-x64-gnu"))
           (copy-recursively "node_modules" #$output))))
   #:options
   `(#:hash-algo sha256
     #:hash ,(base32 "0afnyj99yrlpm7nz0hahifwnvihsmdlrxlspkb53gg4s935ssjvz")
     #:recursive? #t)))

(define-public lirep-mobile
  (package
    (name "lirep-mobile")
    (version "0.0.1")
    (source %mobile-source)
    (build-system copy-build-system)
    (arguments
     (list
      #:install-plan #~'(("mobile/dist" "share/lirep/mobile"))
      #:phases
      #~(modify-phases %standard-phases
          (add-before 'install 'build
            (lambda _
              (with-directory-excursion "mobile"
                (copy-recursively #$lirep-mobile-node-modules "node_modules")
                (invoke "node" "node_modules/vite/bin/vite.js" "build")))))))
    (native-inputs (list node))
    (home-page "https://lirep.org")
    (synopsis "Opening repertoire trainer: mobile web app")
    (description "Static HTML, JavaScript and CSS for Lirep's mobile app,
served at /m/.")
    (license license:agpl3)))
