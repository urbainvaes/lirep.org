;;; Guix package for the local Lichess opening explorer (lila-openingexplorer).
;;;
;;; Only the program is packaged; its database is data and lives elsewhere
;;; (pass --db <directory> when running it).
;;;
;;;   guix build -L deploy/guix lila-openingexplorer

(define-module (lirep explorer)
  #:use-module (guix packages)
  #:use-module (guix gexp)
  #:use-module (guix utils)
  #:use-module (guix modules)
  #:use-module (guix build-system gnu)
  #:use-module ((guix licenses) #:prefix license:)
  #:use-module (gnu packages)
  #:use-module (gnu packages base)
  #:use-module (gnu packages bash)
  #:use-module (gnu packages compression)
  #:use-module (gnu packages databases)
  #:use-module (gnu packages llvm)
  #:use-module (gnu packages linux)
  #:use-module (gnu packages pkg-config)
  #:use-module (gnu packages rust)
  #:use-module (gnu packages tls)
  #:use-module (gnu packages nss)
  #:use-module (gnu packages cmake)
  #:use-module (gnu packages elf)
  #:use-module (gnu packages gcc)
  #:use-module (guix download))

(define %repository-root
  ;; This file is <root>/deploy/guix/lirep/explorer.scm.
  (dirname (dirname (dirname (dirname
    (canonicalize-path (search-path %load-path "lirep/explorer.scm")))))))

(define %explorer-source
  (local-file (string-append %repository-root "/explorer/upstream")
              "lila-openingexplorer-source"
              #:recursive? #t
              #:select?
              (lambda (file stat)
                (not (or (string-contains file "/target")
                         (string-contains file "/.git/"))))))

;; The Explorer's dev-dependencies and benchmark pull in a git dependency
;; (iai) that is not needed to run it; drop them both for vendoring and for
;; building.
(define strip-dev-dependencies
  #~(lambda ()
      (let* ((text (call-with-input-file "Cargo.toml" get-string-all))
             (cut-at (lambda (text marker)
                       (let ((i (string-contains text marker)))
                         (if i (substring text 0 i) text)))))
        (call-with-output-file "Cargo.toml"
          (lambda (port)
            (display (cut-at (cut-at text "[dev-dependencies]") "[[bench]]")
                     port)
            ;; keep [profile.release] and lints, which follow the cut points
            (display (let ((j (string-contains text "[profile.release]")))
                       (if j (substring text j) ""))
                     port))))))

;; cargo needs the network to fetch crates, so they are vendored in a
;; fixed-output derivation.  When Cargo.lock changes, build with a wrong hash
;; and copy the "actual" hash from the error.
(define-public lila-openingexplorer-vendor
  (computed-file
   "lila-openingexplorer-vendor"
   (with-imported-modules '((guix build utils))
     #~(begin
         (use-modules (guix build utils) (ice-9 textual-ports))
         (setenv "HOME" (getcwd))
         ;; nss-certs ships hashed certificate files, not a single bundle.
         (setenv "SSL_CERT_DIR" #$(file-append nss-certs "/etc/ssl/certs"))
         (setenv "PATH" (string-append #$(file-append rust "/bin") ":"
                                       #$rust:cargo "/bin:"
                                       #$(file-append coreutils "/bin") ":"
                                       #$(file-append bash-minimal "/bin")))
         (copy-recursively #$%explorer-source "src-copy")
         (with-directory-excursion "src-copy"
           (for-each make-file-writable (find-files "." "."))
           (#$strip-dev-dependencies)
           (invoke "cargo" "vendor" "--versioned-dirs" #$output))))
   #:options
   `(#:hash-algo sha256
     #:hash ,(base32 "1ha9zsfbbjxch61hw2wyvvprpg2dxnip5vm39wfc4ylil4srg4nc")
     #:recursive? #t)))


;; The Explorer needs a newer Rust than Guix currently packages (shakmaty
;; requires 1.95).  Until Guix catches up, use the official binary toolchain,
;; patched to run on Guix.  Remove this once `rust` in Guix is >= 1.95.
(define-public rust-binary
  (package
    (name "rust-binary")
    (version "1.98.1")
    (source
     (origin
       (method url-fetch)
       (uri (string-append "https://static.rust-lang.org/dist/rust-" version
                           "-x86_64-unknown-linux-gnu.tar.xz"))
       (sha256
        (base32 "0nv00b1x7ykk61l268fkrz10c41x79avdnpqr14d24fyadnb69jk"))))
    (build-system gnu-build-system)
    (supported-systems '("x86_64-linux"))
    (arguments
     (list
      #:tests? #f
      #:strip-binaries? #f
      #:validate-runpath? #f
      #:modules '((guix build gnu-build-system)
                  (guix build utils)
                  (ice-9 binary-ports)
                  (rnrs bytevectors))
      #:phases
      #~(modify-phases %standard-phases
          (delete 'configure)
          (delete 'build)
          (replace 'install
            (lambda* (#:key inputs outputs #:allow-other-keys)
              (let ((out (assoc-ref outputs "out")))
                (invoke "sh" "./install.sh"
                        (string-append "--prefix=" out)
                        "--components=rustc,cargo,rust-std-x86_64-unknown-linux-gnu"
                        "--disable-ldconfig"))))
          (add-after 'install 'patch-elf
            (lambda* (#:key inputs outputs #:allow-other-keys)
              (let* ((out (assoc-ref outputs "out"))
                     (ld.so (string-append #$glibc "/lib/ld-linux-x86-64.so.2"))
                     (rpath (string-join
                             (list (string-append out "/lib")
                                   (dirname ld.so)
                                   (string-append #$gcc:lib "/lib")
                                   (string-append #$zlib "/lib"))
                             ":")))
                (define (elf? file)
                  (and (file-exists? file)
                       (not (file-is-directory? file))
                       (call-with-input-file file
                         (lambda (port)
                           (let ((magic (get-bytevector-n port 4)))
                             (and (bytevector? magic)
                                  (equal? (bytevector->u8-list magic)
                                          '(127 69 76 70))))))))
                (for-each
                 (lambda (file)
                   (when (elf? file)
                     (make-file-writable file)
                     (invoke "patchelf" "--set-rpath" rpath file)
                     ;; Executables need the interpreter; shared objects
                     ;; make patchelf fail, so ignore its status for them.
                     (system* "patchelf" "--set-interpreter" ld.so file)))
                 (find-files out)))))))) 
    (native-inputs (list patchelf))
    (inputs (list glibc zlib `(,gcc "lib")))
    (home-page "https://www.rust-lang.org")
    (synopsis "Official Rust toolchain binaries, patched for Guix")
    (description "The upstream rustc and cargo binary release, relocated to
the store.  A stopgap for programs that need a newer Rust than Guix has.")
    (license (list license:expat license:asl2.0))))

(define-public lila-openingexplorer
  (package
    (name "lila-openingexplorer")
    (version "3.0.0")
    (source %explorer-source)
    (build-system gnu-build-system)
    (arguments
     (list
      #:tests? #f                       ;the test suite needs dev-dependencies
      #:modules '((guix build gnu-build-system)
                  (guix build utils)
                  (ice-9 textual-ports)
                  (srfi srfi-1))
      #:phases
      #~(modify-phases %standard-phases
          (delete 'configure)
          (replace 'build
            (lambda* (#:key inputs #:allow-other-keys)
              (for-each make-file-writable (find-files "." "."))
              (#$strip-dev-dependencies)
              ;; Upstream polls lichess.org for a cheater blacklist, a request
              ;; that is refused (and retried every 5 seconds, forever)
              ;; without a Lichess-issued token.  Only run it when a token is
              ;; configured.
              (substitute* "src/main.rs"
                (("join_set\\.spawn\\(periodic_blacklist_update\\(blacklist, opt\\.lila\\.clone\\(\\)\\)\\);")
                 (string-append
                  "if std::env::var_os(\"EXPLORER_BEARER\").is_some() "
                  "|| std::env::var_os(\"EXPLORER_BEARER_FILE\").is_some() { "
                  "join_set.spawn(periodic_blacklist_update(blacklist, opt.lila.clone())); }")))
              (unless (string-contains
                       (call-with-input-file "src/main.rs" get-string-all)
                       "EXPLORER_BEARER_FILE")
                (error "blacklist patch did not apply"))
              (copy-recursively #$lila-openingexplorer-vendor "vendor")
              ;; Build scripts (jemalloc, ...) copy and write into their
              ;; sources, so the vendored tree must not be read-only.
              (for-each (lambda (f) (chmod f (logior #o200 (stat:perms (lstat f)))))
                        (find-files "vendor" "." #:directories? #t))
              ;; jemalloc's sources hard-code /bin/sh, which does not exist in
              ;; the build container.  Point them at bash, and tell cargo the
              ;; crate's files were modified.
              (let* ((bash (which "bash"))
                     (crate (car (find-files "vendor" "^tikv-jemalloc-sys-"
                                             #:directories? #t #:stat stat)))
                     (checksum (string-append crate "/.cargo-checksum.json")))
                (for-each
                 (lambda (file)
                   (when (and (file-exists? file)
                              (not (file-is-directory? file))
                              (not (symbolic-link? file))
                              (string-contains
                               (call-with-input-file file get-string-all)
                               "/bin/sh"))
                     (substitute* file (("/bin/sh") bash))))
                 (find-files crate "."))
                (let* ((text (call-with-input-file checksum get-string-all))
                       (i (string-contains text "\"package\":")))
                  (call-with-output-file checksum
                    (lambda (port)
                      (format port "{\"files\":{},~a" (substring text i))))))
              (mkdir-p ".cargo")
              (call-with-output-file ".cargo/config.toml"
                (lambda (port)
                  (display "[source.crates-io]
replace-with = \"vendored-sources\"

[source.vendored-sources]
directory = \"vendor\"
" port)))
              (let ((openssl (assoc-ref inputs "openssl")))
                (setenv "OPENSSL_DIR" openssl)
                (setenv "OPENSSL_LIB_DIR" (string-append openssl "/lib"))
                (setenv "OPENSSL_INCLUDE_DIR" (string-append openssl "/include"))
                ;; The crate compiles its own RocksDB: Guix's is built
                ;; without LZ4, which the Explorer's database uses.
                (setenv "LIBCLANG_PATH"
                        (string-append (assoc-ref inputs "clang") "/lib"))
                (setenv "CC" "gcc")
                (setenv "CXX" "g++")
                ;; The build container has no /bin/sh, which the autoconf
                ;; scripts run by jemalloc's build script default to.
                (setenv "CONFIG_SHELL" (which "bash"))
                (setenv "SHELL" (which "bash"))
                (setenv "RUSTFLAGS"
                        (string-append "-C linker=gcc "
                                       "-C link-arg=-Wl,-rpath," openssl "/lib "
                                       " -C link-arg=-Wl,-rpath,"
                                       (assoc-ref inputs "liburing") "/lib"
                                       " -C link-arg=-Wl,-rpath,"
                                       (assoc-ref inputs "lz4") "/lib"
                                       " -C link-arg=-Wl,-rpath,"
                                       (assoc-ref inputs "zstd") "/lib")))
              ;; Run cargo with a minimal environment: the builder's own
              ;; variables (`version', `system', ...) leak into the
              ;; autoconf scripts that jemalloc's build script runs and
              ;; break them.
              (let ((keep '("PATH" "HOME" "CC" "CXX" "RUSTFLAGS" "CONFIG_SHELL" "SHELL"
                            "OPENSSL_DIR" "OPENSSL_LIB_DIR"
                            "OPENSSL_INCLUDE_DIR" "ROCKSDB_LIB_DIR"
                            "LIBCLANG_PATH" "C_INCLUDE_PATH"
                            "CPLUS_INCLUDE_PATH" "CPATH" "LIBRARY_PATH"
                            "PKG_CONFIG_PATH" "SSL_CERT_DIR" "TMPDIR")))
                (apply invoke "env" "-i"
                       (append
                        (filter-map (lambda (name)
                                      (and=> (getenv name)
                                             (lambda (value)
                                               (string-append name "=" value))))
                                    keep)
                        (list "cargo" "build" "--release" "--offline"
                              "--jobs"
                              (number->string (parallel-job-count))))))))
          (replace 'install
            (lambda* (#:key outputs #:allow-other-keys)
              (let ((bin (string-append (assoc-ref outputs "out") "/bin")))
                (install-file "target/release/lila-openingexplorer" bin)))))))
    (native-inputs (list rust-binary pkg-config clang cmake))
    (inputs (list openssl liburing lz4 `(,zstd "lib") zstd clang))
    (home-page "https://github.com/lichess-org/lila-openingexplorer")
    (synopsis "Lichess opening explorer server")
    (description "The opening explorer behind explorer.lichess.ovh, packaged
without its database: pass @code{--db} a directory holding the data.")
    (license license:agpl3+)))
