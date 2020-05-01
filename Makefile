help:
	@echo "dev - makes dev environment with yarn"
	@echo "container - builds development/testing container"
	@echo "run - runs ganache inside container"
	@echo "deploy - deploys contracts inside container"
	@echo "test-container - build container and deploys artifacts"

dev:
	yarn

run:
	docker run -it -p 8545:8545 --name platform-contracts --rm neufund/platform-contracts yarn testrpc

deploy:
	docker exec platform-contracts yarn deploy localhost

test-container: container
	docker run --detach -it -p 8545:8545 --name platform-contracts --rm neufund/platform-contracts yarn testrpc
	sleep 5
	docker exec platform-contracts yarn build
	$(MAKE) deploy
	$(MAKE) down

tests:
	# default 18 decimals test
	yarn test
	# run eto tests in two scales
	EQUITY_TOKEN_DECIMALS=0 yarn truffle test test/ETO/* test/setup.js --network inprocess_test
	EQUITY_TOKEN_DECIMALS=10 yarn truffle test test/ETO/* test/setup.js --network inprocess_test

down:
ifneq ($(shell docker ps -q -f NAME=^/platform-contracts$),)
	-docker stop platform-contracts
endif

container: down
	rm -rf platform-contracts-artifacts
	docker build . -t neufund/platform-contracts

update-artifacts: container
	docker run --detach -it --name platform-contracts --rm -v $(shell pwd)/platform-contracts-artifacts:/usr/src/platform-contracts/platform-contracts-artifacts neufund/platform-contracts yarn testrpc
	sleep 5
	docker exec platform-contracts yarn build
	docker exec platform-contracts yarn deploy localhost
	$(MAKE) down
	cp -r platform-contracts-artifacts platform-contracts-artifacts-m
	$(eval commitid = $(shell git rev-parse HEAD))
	cd platform-contracts-artifacts-m && git remote set-url origin git@github.com:Neufund/platform-contracts-artifacts.git && git add -A && git commit -m "from platform-contracts "$(commitid) && git commit --amend --author="Jenkins <jenkins@neufund.org>" --no-edit && git push origin master
	rm -rf  platform-contracts-artifacts-m
