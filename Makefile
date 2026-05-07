NAME=vscodium-workspaces
DOMAIN=goodm4ven
SRC_DIR=src
SCHEMA_DIR=$(SRC_DIR)/schemas

.PHONY: all pack install clean prepare-dist shexli

build: dist/extension.js

all: build pack
	@echo "Extension built. Now run 'make install' to install it."

node_modules: package.json package-lock.json
	npm ci

dist/extension.js dist/prefs.js: node_modules
	npx tsc

$(SCHEMA_DIR)/gschemas.compiled: $(SCHEMA_DIR)/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas $(SCHEMA_DIR)

prepare-dist: dist/extension.js dist/prefs.js $(SCHEMA_DIR)/gschemas.compiled
	@rm -rf dist/schemas
	@cp -r $(SCHEMA_DIR) dist/
	@cp $(SRC_DIR)/stylesheet.css dist/
	@cp $(SRC_DIR)/metadata.json dist/

$(NAME).zip: prepare-dist
	@command -v zip >/dev/null 2>&1 || { echo "Error: 'zip' is required for 'make pack'. Install it and retry."; exit 1; }
	@rm -f $(NAME).zip
	@(cd dist && zip ../$(NAME).zip -9r . -x "schemas/gschemas.compiled")

pack: shexli

shexli: $(NAME).zip
	@TMP_JSON="$$(mktemp)"; \
	trap 'rm -f "$$TMP_JSON"' EXIT; \
	./scripts/helpers/shexli-scan.sh "$(CURDIR)/$(NAME).zip" --format json > "$$TMP_JSON"; \
	python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); s=d.get('summary', {}); status=s.get('status', 'unknown'); count=int(s.get('finding_count', 0)); clean=(status == 'clean' and count == 0); print(f\"shexli: {'clean gate passed (0 findings)' if clean else f'failed gate (status={status}, findings={count})'}\"); sys.exit(0 if clean else 1)" "$$TMP_JSON"

install: prepare-dist
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@echo "Extension installed. Restart GNOME Shell by signing in again..."
clean:
	rm -rf $(NAME).zip $(SCHEMA_DIR)/gschemas.compiled

clean-all: clean
	rm -rf dist node_modules

distclean: clean
	rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)

help:
	@echo "Available targets:"
	@echo "  all:    Build the extension"
	@echo "  pack:   Create the zip only if Shexli gate passes"
	@echo "  install: Install the extension"
	@echo "  clean:  Remove build artifacts"
	@echo "  help:   Show this help message"

%:
	@:
