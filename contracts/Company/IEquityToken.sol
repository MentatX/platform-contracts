pragma solidity 0.4.26;

import "../Standards/IAgreement.sol";
import "../Standards/IContractId.sol";
import "./IControlledToken.sol";

// version history as per contract id
// 0 - inital version (see IEquityToken_v0.sol)
// 1 - shareNominalValueUlps added and shareNominalValueEurUlps removed in IEquityToken
// 2 - adds ISIN
//   - fixed issueToken `to` bug where address(this) was sent to controller in onGenerateTokens
contract IEquityToken is
    IAgreement,
    IControlledToken,
    IContractId
{
    ////////////////////////
    // Events
    ////////////////////////

    event LogTokensIssued(
        address indexed holder,
        address controller,
        uint256 amount
    );

    event LogTokensDestroyed(
        address indexed holder,
        address controller,
        uint256 amount
    );

    event LogChangeTokenController(
        address oldController,
        address newController,
        address by
    );

    event LogChangeNominee(
        address oldNominee,
        address newNominee,
        address controller,
        address by
    );

    ////////////////////////
    // Public functions
    ////////////////////////

    /// @dev equity token is not divisible (Decimals == 0) but single share is represented by
    ///  tokensPerShare tokens
    function tokensPerShare() public constant returns (uint256);

    // number of shares represented by tokens. we round to the closest value.
    function sharesTotalSupply() public constant returns (uint256);

    /// nominal value of a share in decimal(18) scale in currency as per token controller ISHA
    function shareNominalValueUlps() public constant returns (uint256);

    // returns company legal representative account that never changes
    function companyLegalRepresentative() public constant returns (address);

    // optional International Securities Identification Number
    function ISIN() public constant returns (string);

    /// returns current nominee which is contract legal rep
    function nominee() public constant returns (address);

    /// only by previous nominee
    function changeNominee(address newNominee) public;

    /// controlled, always issues to msg.sender
    function issueTokens(uint256 amount) public;

    /// controlled, may send tokens even when transfer are disabled: to active ETO only
    function distributeTokens(address to, uint256 amount) public;

    // controlled, msg.sender is typically failed ETO
    function destroyTokens(uint256 amount) public;
}
