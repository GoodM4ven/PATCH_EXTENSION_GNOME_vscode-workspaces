NAME=vscodium-workspaces
DOMAIN=goodm4ven

.PHONY: all pack install clean prepare-dist

build: dist/extension.js

all: build pack
	@echo "Extension built. Now run 'make install' to install it."

node_modules: package.json package-lock.json
	npm ci

dist/extension.js dist/prefs.js: node_modules
	npx tsc

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

prepare-dist: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@cp -r schemas dist/
	@cp stylesheet.css dist/
	@cp metadata.json dist/

$(NAME).zip: prepare-dist
	@command -v zip >/dev/null 2>&1 || { echo "Error: 'zip' is required for 'make pack'. Install it and retry."; exit 1; }
	@rm -f $(NAME).zip
	@(cd dist && zip ../$(NAME).zip -9r . -x "schemas/gschemas.compiled")

pack: $(NAME).zip

install: prepare-dist
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@echo "Extension installed. Restart GNOME Shell with Alt+F2, then 'r'. Or login again."

clean:
	rm -rf $(NAME).zip schemas/gschemas.compiled

clean-all: clean
	rm -rf dist node_modules

distclean: clean
	rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)

help:
	@echo "Available targets:"
	@echo "  all:    Build the extension"
	@echo "  pack:   Create a zip file with the extension"
	@echo "  install: Install the extension"
	@echo "  clean:  Remove build artifacts"
	@echo "  help:   Show this help message"

%:
	@:
