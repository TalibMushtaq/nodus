.PHONY: install-hooks
install-hooks:
	mkdir -p .git/hooks
	cp scripts/pre-push .git/hooks/pre-push
	chmod +x .git/hooks/pre-push
	@echo "Git hooks installed."
