.PHONY: install build package clean clean-shogun

install:
	npm install
	npm --prefix shared install
	npm --prefix server install
	npm --prefix web install

build: install
	npm run build

package: build
	npm pack

clean:
	rm -rf shared/dist server/dist web/dist *.tgz

clean-shogun:
	rm -rf .shogun/logs .shogun/history .shogun/message_to .shogun/tmp .shogun/state.json .shogun/waits .shogun/message_processing .shogun/message_ledger.json \
		.shogun/*.bak .shogun/.*.tmp
