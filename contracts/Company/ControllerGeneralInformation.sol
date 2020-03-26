pragma solidity 0.4.26;

import "./ControllerGovernanceBase.sol";


contract ControllerGeneralInformation is
    ControllerGovernanceBase
{
    ////////////////////////
    // Mutable state
    ////////////////////////

    // share capital of Company in currency defined in ISHA
    uint256 internal _shareCapital;

    // authorized capital of Company
    uint256 internal _authorizedCapital;

    // valuation of the company
    uint256 internal _companyValuationEurUlps;

    // are transfers on token enabled
    bool internal _transfersEnabled;



    ////////////////////////
    // Public Methods
    ////////////////////////

    //
    // Implements IControllerGovernance
    //

    function shareholderInformation()
        public
        constant
        returns (
            uint256 shareCapital,
            uint256 companyValuationEurUlps,
            ShareholderRights shareholderRights,
            uint256 authorizedCapital
        )
    {
        return (
            _shareCapital,
            _companyValuationEurUlps,
            _shareholderRights,
            _authorizedCapital
        );
    }

    function tokens()
        public
        constant
        returns (
            address[] token,
            uint256[] sharesFraction
        )
    {
        // no cap table before any shareholder agreement is attached
        if (amendmentsCount() == 0) {
            return;
        }
        token = new address[](1);
        sharesFraction = new uint256[](1);

        token[0] = _equityToken;
        uint256 tps = _equityToken.tokensPerShare();
        sharesFraction[0] = proportion(_equityToken.totalSupply(), DECIMAL_POWER, tps);
    }

    function issueGeneralInformation(
        bytes32 resolutionId,
        string title,
        string documentUrl
    )
        public
        onlyOperational
        onlyCompany
    {
        // we emit this as Ethereum event, no need to store this in contract storage
        emit LogResolutionStarted(resolutionId, title, documentUrl, Action.None, ExecutionState.Completed);
    }

    //
    // Migration storage access
    //

    function migrateGeneralInformation(
        string ISHAUrl,
        uint256 shareCapital,
        uint256 authorizedCapital,
        uint256 companyValuationEurUlps,
        bool transfersEnabled
    )
        public
        onlyState(GovState.Setup)
        only(ROLE_COMPANY_UPGRADE_ADMIN)
    {
        this.amendAgreement(ISHAUrl);
        _shareCapital = shareCapital;
        _authorizedCapital = authorizedCapital;
        _companyValuationEurUlps = companyValuationEurUlps;
        _transfersEnabled = transfersEnabled;
    }

    //
    // Implements IContractId
    //

    function contractId() public pure returns (bytes32 id, uint256 version) {
        return (0x41a703b63c912953a0cd27ec13238571806cc14534c4a31a6874db8759b9aa6a, 0);
    }

    ////////////////////////
    // Internal Methods
    ////////////////////////


    function amendISHA(
        bytes32 resolutionId,
        string memory ISHAUrl,
        uint256 shareCapital,
        uint256 companyValuationEurUlps,
        ShareholderRights newShareholderRights
    )
        internal
    {
        // set ISHA. use this.<> to call externally so msg.sender is correct in mCanAmend
        this.amendAgreement(ISHAUrl);
        // set new share capital
        _shareCapital = shareCapital;
        // set new valuation
        _companyValuationEurUlps = companyValuationEurUlps;
        // set shareholder rights corresponding to SHA part of ISHA
        _shareholderRights = newShareholderRights;
        emit LogISHAAmended(resolutionId, ISHAUrl, shareCapital, companyValuationEurUlps, newShareholderRights);
    }

    function establishAuthorizedCapital(bytes32 resolutionId, uint256 authorizedCapital)
        internal
    {
        // if we implement ESOP that needs to be overriden in ESOP module to not let to deallocate authorized capital
        // below lever required by ESOP
        _authorizedCapital = authorizedCapital;
        emit LogAuthorizedCapitalEstablished(resolutionId, authorizedCapital);
    }

    function enableTransfers(bytes32 resolutionId, bool transfersEnabled)
        internal
    {
        if (_transfersEnabled != transfersEnabled) {
            _transfersEnabled = transfersEnabled;
        }
        emit LogTransfersStateChanged(resolutionId, _equityToken, transfersEnabled);
    }

    //
    // Overrides Agreement
    //

    function mCanAmend(address legalRepresentative)
        internal
        returns (bool)
    {
        // only this contract can amend ISHA typically due to resolution
        return legalRepresentative == address(this);
    }
}
