;; Everything needed to run lirep.org locally, built from Guix packages:
;;
;;   guix shell -L deploy/guix -m deploy/manifest.scm
;;
;; The packages (python-chess, lirep-backend, lirep-frontend) are defined in
;; deploy/guix/lirep/packages.scm.
(use-modules (lirep packages)
             (gnu packages web))

(packages->manifest (list lirep-backend lirep-frontend nginx))
